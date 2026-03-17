/**
 * ============================================================
 * 志愿填报参考 - 后端主程序 (app.js)
 * ============================================================
 * 这是一个 Node.js 后端服务，用 Express 框架提供网页接口（API），
 * 用 MySQL 存数据。主要功能包括：
 * - 在读分享/学生分享的增删查
 * - 智能查询（阿里云百炼 AI）
 * - 信息认证（邮箱验证码、学生证）
 * - 专业/学校数据管理、评论点赞、举报等
 *
 * ----- 小白阅读说明 -----
 * - const/let：声明变量；require('xxx')：引入已安装的包或 Node 内置模块。
 * - app.get('/path', (req, res) => { ... })：收到 GET 请求时执行的函数；
 *   req=请求（含 query、body、headers），res=响应（res.send() 把结果发给前端）。
 * - app.post：同上，处理 POST 请求（一般带 body 提交数据）。
 * - db.run(sql, params, callback)：执行一条 SQL（写）；db.all/db.get：查询多行/一行。
 * - async/await：异步操作，await 会等 Promise 完成再往下执行，避免回调地狱。
 */

// ----- 引入依赖（别人写好的代码包） -----
const express = require('express');       // 网页服务框架，用来写“路由”（哪个网址对应哪个处理函数）
const cors = require('cors');            // 允许浏览器跨域访问本接口
const path = require('path');             // 处理文件路径（Node 内置）
const fs = require('fs');                 // 读写文件（Node 内置）
const { execSync } = require('child_process');  // 执行系统命令（如 git clone）
const mysql = require('mysql2/promise');        // 连接阿里云 MySQL，存放所有业务数据与关键词
const nodemailer = require('nodemailer');       // 发送验证码邮件（避免动态 import 在部分环境失效）
const app = express();                    // 创建 Express 应用实例

// 【必须放在最顶部，所有路由/中间件之前】放大请求体限制，避免学生证 base64 图片触发 PayloadTooLargeError
const BODY_LIMIT = process.env.BODY_LIMIT || '100mb';
app.use(express.json({ limit: BODY_LIMIT }));
app.use(express.urlencoded({ limit: BODY_LIMIT, extended: true }));
console.log('[Express] 请求体大小限制:', BODY_LIMIT);

// ----- 基础配置：从环境变量读取，没有则用默认值 -----
const PORT = process.env.PORT || 7860;   // 服务监听的端口号，process.env 是环境变量

/**
 * 解析数据存放目录。
 * 优先级：DATA_DIR > DATASET_MOUNT_PATH > 自动克隆数据集到 DATASET_LOCAL_PATH。
 * 创空间等环境下可能无法用终端，用环境变量指定或自动克隆。
 */
function resolveDataDir() {
  // Vercel 无持久化盘且不可 git clone，使用 /tmp
  if (process.env.VERCEL) return '/tmp';
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  // 创空间在「配置-关联数据集」里挂载数据集时，可能会出现在某路径，请在该路径的父目录或挂载点设置此变量
  if (process.env.DATASET_MOUNT_PATH) return process.env.DATASET_MOUNT_PATH;
  const datasetId = process.env.AUTO_CLONE_DATASET; // 例如 taoyao0498/Data_for_GAS
  if (!datasetId) return '/home/user/app/data';
  const persistDir = process.env.DATASET_LOCAL_PATH || '/home/user/app/Data_for_GAS';
  const repoUrl = `https://www.modelscope.cn/datasets/${datasetId.trim().replace(/^datasets\/?/, '')}.git`;
  const hasGit = fs.existsSync(path.join(persistDir, '.git'));
  if (!fs.existsSync(persistDir)) {
    fs.mkdirSync(path.dirname(persistDir), { recursive: true });
    let cloned = false;
    // 先尝试系统 git（浅克隆，减少失败率）
    try {
      execSync(`git clone --depth 1 "${repoUrl}" "${persistDir}"`, { stdio: 'pipe', timeout: 90000 });
      cloned = true;
      console.log('✅ 已自动克隆数据集到', persistDir);
    } catch (gitErr) {
      const msg = (gitErr.stderr && gitErr.stderr.toString()) || gitErr.message;
      console.warn('自动克隆数据集失败（可能容器内无 git 或网络限制）:', msg.slice(0, 200));
    }
    if (!cloned) {
      console.warn('请改用：在创空间配置里「关联数据集」后，把数据集挂载路径设为环境变量 DATA_DIR 或 DATASET_MOUNT_PATH');
    }
  } else if (hasGit) {
    try {
      execSync(`git -C "${persistDir}" pull --rebase --depth 1`, { stdio: 'pipe', timeout: 30000 });
    } catch (e) {
      console.warn('拉取数据集最新内容失败（可忽略）:', e.message);
    }
  }
  return persistDir;
}

const DATA_DIR = resolveDataDir();

// ----- 阿里云百炼（千问）配置：智能查询 + 学生证鉴伪 + 文本审核 共用同一 Key -----
// 志愿查询用应用 completion；学生证鉴伪、发帖/评论审核用模型 API（compatible-mode），均使用 BAILIAN_API_KEY
const BAILIAN_API_KEY = process.env.BAILIAN_API_KEY || process.env.DIRECT_AI_KEY;
const BAILIAN_APP_ID = process.env.BAILIAN_APP_ID;
const DASHSCOPE_VISION_MODEL = process.env.DASHSCOPE_VISION_MODEL || 'qwen-vl-plus'; // 学生证视觉模型
const DASHSCOPE_BASE = 'https://dashscope.aliyuncs.com';
// 认证 token 有效期：10 年，认证后长期有效，用于发帖、举报等
const TOKEN_EXPIRY_MS = 10 * 365 * 24 * 60 * 60 * 1000;

/** MySQL DATETIME 只接受 'YYYY-MM-DD HH:MM:SS'，不能带 T/Z 或毫秒 */
function toMySQLDateTime(dateOrIso) {
  const d = dateOrIso instanceof Date ? dateOrIso : new Date(dateOrIso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

// 旧配置（兼容用）
const AI_API_KEY = process.env.AI_KEY;

// ----- DeepSeek 配置：邮箱后缀识别学校、专业数据录入（单条/批量/按学校） -----
// 当前 vercel.json 将请求代理到自建后端，DEEPSEEK_API_KEY 需在「运行本 Node 的后端服务器」上配置
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_KEY;
const DEEPSEEK_API_URL = process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/v1/chat/completions';
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

// 确保数据目录存在（不存在就创建）；Vercel 下 /tmp 已存在，不写盘
if (!process.env.VERCEL && !fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// 旧的 SQLite 数据库文件路径（仅用于参考，实际业务已全部切换到 MySQL）
const DB_PATH = path.join(DATA_DIR, 'study_experience.db');

// ----- MySQL 配置：用于存储所有业务数据及“帖子是否有用”的关键词与分类 -----
// 注意：用户名和密码等敏感信息只从环境变量读取，不在代码中硬编码
const MYSQL_HOST = process.env.MYSQL_HOST || '115.29.233.160'; // 可用环境变量覆盖
const MYSQL_PORT = parseInt(process.env.MYSQL_PORT || '3306', 10);
const MYSQL_USER = process.env.MYSQL_USER;       // 必须在环境变量中设置
const MYSQL_PASSWORD = process.env.MYSQL_PASSWORD; // 必须在环境变量中设置
const MYSQL_DATABASE = process.env.MYSQL_DATABASE || 'ycyz_db';

let mysqlPool = null;

// 默认关键词与分类：仅用于首次初始化 MySQL 表或 MySQL 不可用时兜底
const DEFAULT_KEYWORD_CATEGORY_PAIRS = [
  // 学习与升学
  { keyword: '学业', category: '学习与成绩' },
  { keyword: '课程', category: '学习与成绩' },
  { keyword: '保研', category: '学习与成绩' },
  { keyword: '就业', category: '学习与成绩' },
  { keyword: '面试', category: '学习与成绩' },
  { keyword: '压力', category: '学习与成绩' },
  { keyword: '位次', category: '学习与成绩' },
  { keyword: '学习', category: '学习与成绩' },
  { keyword: '高考', category: '学习与成绩' },

  // 生活与住宿
  { keyword: '宿舍', category: '生活与住宿' },
  { keyword: '食堂', category: '生活与住宿' },
  { keyword: '生活', category: '生活与住宿' },
  { keyword: '伙食', category: '生活与住宿' },
  { keyword: '生活费', category: '生活与住宿' },
  { keyword: '校园设施', category: '生活与住宿' },
  { keyword: '交通', category: '生活与住宿' },
  { keyword: '安全', category: '生活与住宿' },
  { keyword: '医疗', category: '生活与住宿' },
  { keyword: '校园环境', category: '生活与住宿' },
  { keyword: '校园文化', category: '生活与住宿' },
  { keyword: '校园活动', category: '生活与住宿' },

  // 费用与资助
  { keyword: '住宿费', category: '费用与资助' },
  { keyword: '学费', category: '费用与资助' },
  { keyword: '奖学金', category: '费用与资助' },
  { keyword: '助学贷款', category: '费用与资助' },
  { keyword: '助学金', category: '费用与资助' },
  { keyword: '勤工俭学', category: '费用与资助' },
  { keyword: '校园卡', category: '费用与资助' },
  { keyword: '校园网', category: '费用与资助' },

  // 发展与机会
  { keyword: '招聘', category: '发展与机会' },
  { keyword: '创业', category: '发展与机会' },
  { keyword: '创新', category: '发展与机会' },
  { keyword: '竞赛', category: '发展与机会' },
  { keyword: '比赛', category: '发展与机会' },
  { keyword: '社团', category: '发展与机会' },

  // 备考与学习方法
  { keyword: '复习计划', category: '备考与学习方法' },
  { keyword: '考前突击', category: '备考与学习方法' },
  { keyword: '背书技巧', category: '备考与学习方法' },
  { keyword: '错题本', category: '备考与学习方法' },
  { keyword: '网课推荐', category: '备考与学习方法' },
  { keyword: '教辅测评', category: '备考与学习方法' },
  { keyword: '时间轴', category: '备考与学习方法' },
  { keyword: '自习室', category: '备考与学习方法' },
  { keyword: '自律打卡', category: '备考与学习方法' },
  { keyword: '专业课', category: '备考与学习方法' },
  { keyword: '公共课', category: '备考与学习方法' },
  { keyword: '备考心态', category: '备考与学习方法' },
  { keyword: '压题', category: '备考与学习方法' },
  { keyword: '速成攻略', category: '备考与学习方法' },
  { keyword: '思维模型', category: '备考与学习方法' },
  { keyword: '论文写作', category: '备考与学习方法' },
  { keyword: '文献检索', category: '备考与学习方法' },
  { keyword: '小组作业', category: '备考与学习方法' }
];

let keywordCategoriesCache = null;
let keywordCategoriesCacheTime = 0;
const KEYWORD_CATEGORIES_CACHE_TTL_MS = 10 * 60 * 1000; // 10 分钟缓存

async function initMySQLForKeywords() {
  if (mysqlPool) return mysqlPool;
  try {
    if (!MYSQL_USER || !MYSQL_PASSWORD) {
      throw new Error('缺少 MySQL 用户名或密码，请通过环境变量 MYSQL_USER / MYSQL_PASSWORD 配置');
    }
    const baseConfig = {
      host: MYSQL_HOST,
      port: MYSQL_PORT,
      user: MYSQL_USER,
      password: MYSQL_PASSWORD,
      connectTimeout: 10000  // 10 秒超时，避免连接挂起导致“很慢”的体感
    };
    const connection = await mysql.createConnection(baseConfig);
    await connection.query(
      `CREATE DATABASE IF NOT EXISTS \`${MYSQL_DATABASE}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    await connection.end();

    mysqlPool = mysql.createPool({
      ...baseConfig,
      database: MYSQL_DATABASE,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 20,
      connectTimeout: 10000,
      charset: 'utf8mb4_general_ci'
    });

    // 1) 关键词与分类表
    await mysqlPool.query(`
      CREATE TABLE IF NOT EXISTS keyword_categories (
        id INT AUTO_INCREMENT PRIMARY KEY,
        keyword VARCHAR(255) NOT NULL,
        category VARCHAR(255) NOT NULL,
        UNIQUE KEY uk_keyword (keyword)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // 2) 业务主表：基本结构与原 SQLite 一致
    await mysqlPool.query(`
      CREATE TABLE IF NOT EXISTS user_uploads (
        id INT AUTO_INCREMENT PRIMARY KEY,
        school VARCHAR(255),
        major VARCHAR(255),
        city VARCHAR(255),
        gaokao_year INT,
        experience TEXT,
        label VARCHAR(255),
        upload_time DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await mysqlPool.query(`
      CREATE TABLE IF NOT EXISTS student_shares (
        id INT AUTO_INCREMENT PRIMARY KEY,
        school VARCHAR(255),
        major VARCHAR(255),
        grade VARCHAR(255),
        title VARCHAR(255),
        content LONGTEXT,
        tags TEXT,
        images LONGTEXT,
        status VARCHAR(50) DEFAULT 'approved',
        upload_time DATETIME DEFAULT CURRENT_TIMESTAMP,
        author_nickname VARCHAR(255),
        share_number INT UNIQUE,
        usefulness_ratio DOUBLE,
        is_emotional TINYINT DEFAULT 0,
        analyzed_at DATETIME,
        delete_after DATETIME
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await mysqlPool.query(`
      CREATE TABLE IF NOT EXISTS verification_codes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        code VARCHAR(32) NOT NULL,
        school_name VARCHAR(255),
        expires_at DATETIME NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await mysqlPool.query(`
      CREATE TABLE IF NOT EXISTS verified_users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        school_name VARCHAR(255) NOT NULL,
        auth_type VARCHAR(50) DEFAULT 'email',
        auth_token VARCHAR(255) NOT NULL,
        token_expires_at DATETIME NOT NULL,
        verified_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        nickname VARCHAR(255),
        UNIQUE KEY uk_verified_email (email),
        UNIQUE KEY uk_verified_token (auth_token)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await mysqlPool.query(`
      CREATE TABLE IF NOT EXISTS student_id_verifications (
        id INT AUTO_INCREMENT PRIMARY KEY,
        school_name VARCHAR(255) NOT NULL,
        image_data LONGTEXT,
        status VARCHAR(50) NOT NULL DEFAULT 'pending_manual',
        auth_token VARCHAR(255),
        token_expires_at DATETIME,
        ali_task_id VARCHAR(255),
        nickname VARCHAR(255),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await mysqlPool.query(`
      CREATE TABLE IF NOT EXISTS share_reports (
        id INT AUTO_INCREMENT PRIMARY KEY,
        share_id INT NOT NULL,
        user_email VARCHAR(255) NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_share_reports_share_id (share_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await mysqlPool.query(`
      CREATE TABLE IF NOT EXISTS share_likes (
        share_id INT NOT NULL,
        user_email VARCHAR(255) NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (share_id, user_email)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await mysqlPool.query(`
      CREATE TABLE IF NOT EXISTS share_comments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        share_id INT NOT NULL,
        parent_id INT NULL,
        user_email VARCHAR(255) NOT NULL,
        school_name VARCHAR(255) NOT NULL,
        nickname VARCHAR(255) NOT NULL,
        content TEXT NOT NULL,
        status VARCHAR(50) DEFAULT 'approved',
        like_count INT DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        usefulness_ratio DOUBLE,
        is_emotional TINYINT DEFAULT 0,
        analyzed_at DATETIME,
        delete_after DATETIME,
        INDEX idx_share_comments_share_id (share_id),
        INDEX idx_share_comments_parent_id (parent_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await mysqlPool.query(`
      CREATE TABLE IF NOT EXISTS comment_reports (
        id INT AUTO_INCREMENT PRIMARY KEY,
        comment_id INT NOT NULL,
        user_email VARCHAR(255) NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_comment_reports_comment_id (comment_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await mysqlPool.query(`
      CREATE TABLE IF NOT EXISTS comment_likes (
        comment_id INT NOT NULL,
        user_email VARCHAR(255) NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (comment_id, user_email)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await mysqlPool.query(`
      CREATE TABLE IF NOT EXISTS schools (
        id INT AUTO_INCREMENT PRIMARY KEY,
        school_name VARCHAR(255) NOT NULL,
        school_level VARCHAR(255),
        location VARCHAR(255),
        description TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_school_name (school_name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await mysqlPool.query(`
      CREATE TABLE IF NOT EXISTS school_major_programs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        school_name VARCHAR(255) NOT NULL,
        major_id INT,
        major_name VARCHAR(255),
        program_features TEXT,
        courses TEXT,
        stream_division VARCHAR(255),
        admission_requirements TEXT,
        tuition_fee VARCHAR(255),
        scholarships VARCHAR(255),
        contact_info TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await mysqlPool.query(`
      CREATE TABLE IF NOT EXISTS major_overviews (
        id INT AUTO_INCREMENT PRIMARY KEY,
        major_code VARCHAR(255) UNIQUE,
        major_name VARCHAR(255) NOT NULL,
        category VARCHAR(255),
        degree_type VARCHAR(255),
        duration VARCHAR(255),
        description TEXT,
        core_courses TEXT,
        career_prospects TEXT,
        related_majors TEXT,
        training_plan TEXT,
        admission_plan TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await mysqlPool.query(`
      CREATE TABLE IF NOT EXISTS school_programs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        major_id INT,
        school_name VARCHAR(255) NOT NULL,
        school_level VARCHAR(255),
        location VARCHAR(255),
        program_features TEXT,
        courses TEXT,
        course_intros TEXT,
        admission_requirements TEXT,
        tuition_fee VARCHAR(255),
        scholarships VARCHAR(255),
        contact_info TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await mysqlPool.query(`
      CREATE TABLE IF NOT EXISTS major_news (
        id INT AUTO_INCREMENT PRIMARY KEY,
        major_id INT,
        title VARCHAR(255) NOT NULL,
        content TEXT,
        source VARCHAR(255),
        publish_date VARCHAR(64),
        is_hot TINYINT DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // 如果关键词表是空的，用默认关键词初始化一次（去重）
    const [rows] = await mysqlPool.query('SELECT COUNT(*) AS cnt FROM keyword_categories');
    const count = rows && rows[0] && rows[0].cnt ? Number(rows[0].cnt) : 0;
    if (count === 0 && DEFAULT_KEYWORD_CATEGORY_PAIRS.length) {
      const values = DEFAULT_KEYWORD_CATEGORY_PAIRS.map((p) => [p.keyword, p.category]);
      await mysqlPool.query(
        'INSERT IGNORE INTO keyword_categories (keyword, category) VALUES ?',
        [values]
      );
      console.log('✅ 已向 MySQL.keyword_categories 初始化默认关键词与分类');
    }

    console.log('✅ 已连接到 MySQL，并确保所有业务表存在');
  } catch (e) {
    console.error('❌ 连接 MySQL 或初始化 keyword_categories 失败，将退回使用代码内默认关键词：', e.message);
    mysqlPool = null;
  }
  return mysqlPool;
}

async function loadKeywordCategories() {
  const now = Date.now();
  if (keywordCategoriesCache && now - keywordCategoriesCacheTime < KEYWORD_CATEGORIES_CACHE_TTL_MS) {
    return keywordCategoriesCache;
  }

  await initMySQLForKeywords();
  const byCategory = {};

  if (mysqlPool) {
    try {
      const [rows] = await mysqlPool.query('SELECT keyword, category FROM keyword_categories');
      if (rows && rows.length > 0) {
        for (const row of rows) {
          const kw = String(row.keyword || '').trim();
          const cat = String(row.category || '').trim() || '未分类';
          if (!kw) continue;
          if (!byCategory[cat]) byCategory[cat] = [];
          if (!byCategory[cat].includes(kw)) {
            byCategory[cat].push(kw);
          }
        }
      }
    } catch (e) {
      console.error('从 MySQL 读取关键词失败，将使用内置默认关键词：', e.message);
    }
  }

  // MySQL 不可用或表为空时，使用内置默认值
  if (!Object.keys(byCategory).length) {
    for (const pair of DEFAULT_KEYWORD_CATEGORY_PAIRS) {
      const kw = pair.keyword;
      const cat = pair.category || '未分类';
      if (!byCategory[cat]) byCategory[cat] = [];
      if (!byCategory[cat].includes(kw)) {
        byCategory[cat].push(kw);
      }
    }
  }

  keywordCategoriesCache = byCategory;
  keywordCategoriesCacheTime = now;
  return byCategory;
}

// ----- 兼容 SQLite API 的 MySQL 封装：提供 db.run / db.all / db.get -----
// 防御：MySQL DATETIME 不接受 ISO8601，若 params 中误传了 ISO 字符串或 Date 对象则在此统一转换
function ensureMySQLParams(params) {
  if (!Array.isArray(params)) return params || [];
  return params.map((p) => {
    if (p instanceof Date) return toMySQLDateTime(p);
    if (typeof p === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(p)) return toMySQLDateTime(p);
    return p;
  });
}

/** 将前端/JSON 的布尔值转为 MySQL TINYINT(1)：避免 true/false/"false" 等与 MySQL 不兼容 */
function toTinyInt(v) {
  return (v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true') ? 1 : 0;
}

const db = {
  run(sql, params, callback) {
    if (typeof params === 'function') {
      callback = params;
      params = [];
    }
    const safeParams = ensureMySQLParams(params);
    initMySQLForKeywords()
      .then(() => mysqlPool.execute(sql, safeParams))
      .then(([result]) => {
        if (!callback) return;
        const ctx = {
          lastID: result.insertId,
          changes: result.affectedRows
        };
        callback.call(ctx, null);
      })
      .catch((err) => {
        console.error('db.run error:', err);
        if (callback) callback(err);
      });
  },
  all(sql, params, callback) {
    if (typeof params === 'function') {
      callback = params;
      params = [];
    }
    const safeParams = ensureMySQLParams(params);
    initMySQLForKeywords()
      .then(() => mysqlPool.execute(sql, safeParams))
      .then(([rows]) => {
        if (callback) callback(null, rows);
      })
      .catch((err) => {
        console.error('db.all error:', err);
        if (callback) callback(err);
      });
  },
  get(sql, params, callback) {
    if (typeof params === 'function') {
      callback = params;
      params = [];
    }
    const safeParams = ensureMySQLParams(params);
    initMySQLForKeywords()
      .then(() => mysqlPool.execute(sql, safeParams))
      .then(([rows]) => {
        if (callback) callback(null, rows[0] || null);
      })
      .catch((err) => {
        console.error('db.get error:', err);
        if (callback) callback(err);
      });
  }
};

// ----- 中间件：所有请求都会先经过这些 -----
app.use(cors());   // 允许前端从别的域名访问本接口
// 请求体解析已在 app 顶部配置为 50mb，此处不再重复

// 静态文件：当前目录下的 html/css/js 等直接当网站文件提供
app.use(express.static(path.join(__dirname)));

// ----- 邮件配置（发验证码用）：SMTP 客户端初始化在 express 之后、所有路由之前 -----
let transporter = null;

if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  const smtpHost = process.env.SMTP_HOST.trim();
  const smtpPort = parseInt(process.env.SMTP_PORT, 10) || 465; // 优先 465 避开阿里云拦截
  const smtpUser = process.env.SMTP_USER.trim();
  const smtpPass = process.env.SMTP_PASS.trim();

  console.log('===== SMTP配置信息 =====');
  console.log('SMTP服务器:', smtpHost);
  console.log('SMTP端口:', smtpPort);
  console.log('发件人邮箱:', smtpUser);
  console.log('=========================');

  try {
    transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: { user: smtpUser, pass: smtpPass },
      requireTLS: smtpPort === 587,
      tls: {
        rejectUnauthorized: false,
        minVersion: 'TLSv1.2',
        maxVersion: 'TLSv1.3',
        servername: smtpHost
      },
      connectionTimeout: 30 * 1000,
      greetingTimeout: 30 * 1000,
      socketTimeout: 60 * 1000,
      debug: true,
      logger: true
    });

    transporter.verify((error, success) => {
      if (error) {
        console.error('❌ SMTP连接失败，详细错误：', error);
        transporter = null;
      } else {
        console.log('✅ SMTP邮件服务连接成功，可正常发送邮件');
      }
    });
  } catch (e) {
    console.error('❌ SMTP客户端初始化异常：', e);
    transporter = null;
  }
}

/** 发送验证码邮件（容错 + 日志）；SMTP 不可用时进入测试模式并把验证码打日志 */
async function sendVerifyEmail(toEmail, code) {
  if (!transporter) {
    const testMsg = `⚠️ SMTP服务不可用，进入测试模式，收件人：${toEmail}，验证码：${code}`;
    console.warn(testMsg);
    return { success: false, testMode: true, code, msg: testMsg };
  }
  const fromAddr = process.env.SMTP_FROM || process.env.SMTP_USER || '';
  try {
    const sendResult = await transporter.sendMail({
      from: `"志愿填报系统" <${fromAddr}>`,
      to: toEmail,
      subject: '【志愿填报系统】邮箱认证验证码',
      text: `您的验证码是：${code}，有效期10分钟，请勿泄露给他人。`,
      html: `您的验证码是：<b style="font-size: 20px; color: #165DFF;">${code}</b>，有效期10分钟，请勿泄露给他人。`
    });
    console.log('✅ 邮件发送成功，收件人：', toEmail, '发送结果：', sendResult);
    return { success: true, msg: '邮件发送成功' };
  } catch (sendError) {
    console.error('❌ 邮件发送失败，收件人：', toEmail, '详细错误：', sendError);
    return { success: false, error: sendError, msg: '邮件发送失败' };
  }
}

// 下面开始的所有 db.run/db.all/db.get 调用，已通过上方的 MySQL 封装实现，
// 不再依赖本地 SQLite 文件。

// ========== 功能1：保存「在读分享」到数据库 ==========
// POST /save-data：前端提交学校、专业、城市、高考年份、经历、标签，插入 user_uploads 表
app.post('/save-data', (req, res) => {
  const { school, major, city, gaokao_year, experience, label } = req.body;  // 从请求体解构出字段
  const sql = `INSERT INTO user_uploads (school, major, city, gaokao_year, experience, label) VALUES (?, ?, ?, ?, ?, ?)`;  // ? 占位符防注入
  db.run(sql, [school, major, city, gaokao_year, experience, label], function(err) {
    if (err) {
      console.error("存数据失败:", err);
      res.send({ code: 500, msg: "存数据失败" });
      return;
    }
    res.send({ code: 200, msg: "存数据成功！" });
  });
});

// ========== 功能2：获取「在读分享」列表 ==========
// GET /get-data：查 user_uploads 表，按上传时间倒序，返回给前端展示
app.get('/get-data', (req, res) => {
  const sql = `SELECT * FROM user_uploads ORDER BY upload_time DESC`;
  db.all(sql, [], (err, rows) => {
    if (err) {
      console.error("取数据失败:", err);
      res.send({ code: 500, msg: "取数据失败" });
      return;
    }
    res.send({ code: 200, data: rows });
  });
});

// ========== 功能3：智能查询（百炼 AI + 学生分享筛选与总结） ==========
// 下面这个条件：只取已通过、有用度>=40、非情绪化、未到删除时间的帖子
const SHARE_LIST_WHERE = `s.status = 'approved'
  AND (s.usefulness_ratio IS NULL OR s.usefulness_ratio >= 40)
  AND (s.is_emotional IS NULL OR s.is_emotional = 0)
  AND (s.delete_after IS NULL OR s.delete_after > NOW())`;

/**
 * 从用户问题里检测是否提到具体学校名（从学生分享表里出现的学校名匹配）
 * 返回 { school, keyword } 或 null，用于决定按“某校+关键词”还是按“关键词”取帖
 */
function getSchoolFromPrompt(prompt) {
  return new Promise((resolve) => {
    db.all(
      `SELECT DISTINCT s.school FROM student_shares s WHERE ${SHARE_LIST_WHERE.replace(/s\./g, 's.')} AND s.school IS NOT NULL AND TRIM(s.school) != ''`,
      [],
      (err, rows) => {
        if (err || !rows || rows.length === 0) return resolve(null);
        const p = (prompt || '').trim();
        const sorted = rows.map((r) => (r.school || '').trim()).filter(Boolean).sort((a, b) => b.length - a.length);
        for (const school of sorted) {
          if (school && p.includes(school)) {
            const keyword = p.replace(school, '').replace(/[？?]\s*$/, '').trim();
            return resolve({ school, keyword: keyword.length >= 1 ? keyword : '' });
          }
        }
        resolve(null);
      }
    );
  });
}

/** 按学校（及可选关键词）取点赞数最高的最多 limit 条帖子，供智能查询总结用 */
function fetchTopSharesBySchool(schoolName, keyword, limit = 100) {
  return new Promise((resolve) => {
    let sql = `SELECT s.id, s.school, s.major, s.title, s.content, s.tags, s.author_nickname, s.upload_time,
      (SELECT COUNT(*) FROM share_likes sl WHERE sl.share_id = s.id) AS like_count
      FROM student_shares s WHERE ${SHARE_LIST_WHERE} AND s.school = ?`;
    const params = [schoolName];
    if (keyword && keyword.trim()) {
      const k = '%' + keyword.trim() + '%';
      sql += ` AND (s.title LIKE ? OR s.content LIKE ? OR s.tags LIKE ?)`;
      params.push(k, k, k);
    }
    sql += ` ORDER BY like_count DESC LIMIT ?`;
    params.push(String(limit));
    db.all(sql, params, (err, rows) => {
      if (err) return resolve([]);
      resolve(rows || []);
    });
  });
}

/** 从用户输入里用空格/标点拆出关键词（至少 2 个字），用于按热度取帖 */
function extractKeywords(prompt) {
  return (prompt || '')
    .replace(/[,，、；;!\s]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2);
}

/** 按关键词匹配取点赞数最高的最多 limit 条；没关键词就取全局热度前 limit 条 */
function fetchTopSharesByKeyword(prompt, limit = 100) {
  return new Promise((resolve) => {
    const keywords = extractKeywords(prompt);
    const baseSql = `SELECT s.id, s.school, s.major, s.title, s.content, s.tags, s.author_nickname, s.upload_time,
      (SELECT COUNT(*) FROM share_likes sl WHERE sl.share_id = s.id) AS like_count
      FROM student_shares s WHERE ${SHARE_LIST_WHERE}`;
    if (keywords.length === 0) {
      db.all(baseSql + ` ORDER BY like_count DESC LIMIT ?`, [String(limit)], (err, rows) => {
        if (err) return resolve([]);
        resolve(rows || []);
      });
      return;
    }
    const conditions = keywords.map(() => '(s.title LIKE ? OR s.content LIKE ? OR s.tags LIKE ? OR s.school LIKE ? OR s.major LIKE ?)').join(' OR ');
    const params = keywords.flatMap((k) => {
      const p = '%' + k + '%';
      return [p, p, p, p, p];
    });
    params.push(String(limit));
    db.all(baseSql + ` AND (${conditions}) ORDER BY like_count DESC LIMIT ?`, params, (err, rows) => {
      if (err) return resolve([]);
      resolve(rows || []);
    });
  });
}

/**
 * 根据用户输入从学生分享里筛出相关帖子（关键词匹配），限制条数避免 AI 超时
 * 与列表规则一致：排除无用、情绪化、已到删除时间的帖子
 */
function fetchRelevantShares(prompt, limit = 10) {
  return new Promise((resolve) => {
    const where = `status = 'approved'
      AND (usefulness_ratio IS NULL OR usefulness_ratio >= 40)
      AND (is_emotional IS NULL OR is_emotional = 0)
      AND (delete_after IS NULL OR delete_after > NOW())`;
    db.all(
      `SELECT id, school, major, grade, title, content, tags, author_nickname, upload_time FROM student_shares WHERE ${where} ORDER BY upload_time DESC LIMIT 80`,
      [],
      (err, rows) => {
        if (err || !rows || rows.length === 0) {
          return resolve([]);
        }
        const keywords = (prompt || '')
          .replace(/[,，、；;!\s]+/g, ' ')
          .split(/\s+/)
          .filter((w) => w.length >= 2);
        if (keywords.length === 0) {
          return resolve(rows.slice(0, limit));
        }
        const lower = (s) => (s || '').toLowerCase();
        const matched = rows.filter((row) => {
          const text = [row.school, row.major, row.title, row.content, row.tags].map(lower).join(' ');
          return keywords.some((k) => text.includes(lower(k)));
        });
        resolve((matched.length ? matched : rows).slice(0, limit));
      }
    );
  });
}

/** 调用百炼应用：把多条帖子内容拼成一段文字，让 AI 总结成一段文案，最多传 maxTextLen 字符 */
async function summarizeSharesWithBailian(fetch, postsText, summaryPrompt, maxTextLen = 28000) {
  const appUrl = `${DASHSCOPE_BASE}/api/v1/apps/${BAILIAN_APP_ID}/completion`;
  const body = JSON.stringify({
    input: { prompt: summaryPrompt + '\n\n帖子内容：\n' + postsText.slice(0, maxTextLen) },
    parameters: { result_format: 'message' }
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  try {
    const res = await fetch(appUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${BAILIAN_API_KEY}` },
      body,
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!res.ok) return '';
    let text;
    try {
      const json = await res.json();
      text = json.output?.text || json.output?.choices?.[0]?.message?.content || json.data?.output?.text || json.choices?.[0]?.message?.content;
    } catch (e) {
      // 如果不是 JSON，获取纯文本
      const rawText = await res.text();
      text = rawText.trim();
    }
    return typeof text === 'string' ? text.trim() : '';
  } catch (e) {
    clearTimeout(timeout);
    return '';
  }
}

// POST /ai-query：智能查询。取学生分享（按学校或关键词热度 top100）总结 + 用户「我的信息」与选科，一起发给百炼，返回报考建议
app.post('/ai-query', async (req, res) => {
  const { prompt, profileSummary, isXuanke, xuankeContext } = req.body;
  
  try {
    const fetch = (await import('node-fetch')).default;
    if (!BAILIAN_API_KEY || !BAILIAN_APP_ID) {
      res.send({ code: 500, msg: "智能查询未配置（需 BAILIAN_API_KEY 与 BAILIAN_APP_ID）" });
      return;
    }

    const MAX_SUMMARY_SNIPPET = 350;
    let shareSummary = '';
    let summaryLabel = '';

    // 学生分享总结：涉及具体学校则按该校+关键词取热度 top100；否则按用户输入关键词取热度 top100
    const detected = await getSchoolFromPrompt(prompt);
    let topShares;
    if (detected && detected.school) {
      topShares = await fetchTopSharesBySchool(detected.school, detected.keyword, 100);
      summaryLabel = `该校（${detected.school}）学生分享`;
    } else {
      topShares = await fetchTopSharesByKeyword(prompt, 100);
      summaryLabel = '与您问题相关的学生分享（按热度排序）';
    }

    if (topShares.length > 0) {
      const postsText = topShares.map((entry, i) => {
        const contentSnippet = (entry.content || '').slice(0, MAX_SUMMARY_SNIPPET);
        return `[${i + 1}] 点赞${entry.like_count || 0} · ${entry.title || '无标题'}\n${contentSnippet}${(entry.content || '').length > MAX_SUMMARY_SNIPPET ? '…' : ''}`;
      }).join('\n\n');
      const summaryPrompt = `用户问题：${prompt}\n\n请对以下「${summaryLabel}」帖子进行总结，围绕用户问题的关注点归纳（如学习压力、宿舍、就业、保研等）。共 ${topShares.length} 条，已按点赞从高到低排列。总结控制在 500 字以内，条理清晰。`;
      shareSummary = await summarizeSharesWithBailian(fetch, postsText, summaryPrompt);
      if (!shareSummary) console.error('学生分享总结调用失败');
    }

    // 参考信息（不含用户问题）：我的信息 + 选科 + 学生分享总结
    const referenceParts = [];
    referenceParts.push('请严格根据下方「参考信息」回答「用户问题」，结合用户填写的我的信息与选科给出专业报考建议；学生分享总结供参考。勿编造参考中未出现的内容。');
    referenceParts.push('\n【参考信息】');
    if (profileSummary && profileSummary !== "（未填写）") {
      referenceParts.push(`用户基本信息（我的信息）：${profileSummary}`);
    }
    if (isXuanke && xuankeContext) {
      const combo = [xuankeContext.first, ...(xuankeContext.second || [])].filter(Boolean).join("+");
      referenceParts.push(`选科：首选 ${xuankeContext.first || '未选'}，再选 ${(xuankeContext.second || []).join('、') || '未选'}（${combo}），省份：${xuankeContext.province || '未填'}`);
    }
    if (shareSummary) {
      referenceParts.push(`【学生分享总结（热度最高最多 100 条）】\n${shareSummary}`);
    }
    const referenceBlock = referenceParts.join('\n');
    const userQuestion = (prompt || '').trim();

    // 分列发送：参考信息与用户问题分开，便于模型区分
    const fullPrompt = `${referenceBlock}\n\n【用户问题】\n${userQuestion}`;

    const appUrl = `${DASHSCOPE_BASE}/api/v1/apps/${BAILIAN_APP_ID}/completion`;
    const callBailian = (signal) => fetch(appUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${BAILIAN_API_KEY}`
      },
      body: JSON.stringify({
        input: { prompt: fullPrompt },
        parameters: { result_format: 'message' }
      }),
      signal
    });
    const BAILIAN_TIMEOUT_MS = 90000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), BAILIAN_TIMEOUT_MS);
    let response;
    try {
      response = await callBailian(controller.signal);
    } catch (fetchErr) {
      clearTimeout(timeoutId);
      if (fetchErr.name === 'AbortError') {
        console.error("智能查询 百炼 请求超时（" + (BAILIAN_TIMEOUT_MS / 1000) + "s）");
        res.send({ code: 500, msg: "AI 响应超时，请缩短问题或稍后重试" });
      } else {
        console.error("智能查询 百炼 网络异常:", fetchErr.message);
        res.send({ code: 500, msg: "AI 服务暂时不可达，请稍后重试" });
      }
      return;
    }
    clearTimeout(timeoutId);
    if (!response.ok) {
      const rawErr = await response.text();
      console.error("智能查询 百炼 API 错误:", response.status, rawErr.slice(0, 400));
      if (response.status >= 500 && response.status < 600) {
        await new Promise((r) => setTimeout(r, 2000));
        const retryController = new AbortController();
        const retryTimeout = setTimeout(() => retryController.abort(), BAILIAN_TIMEOUT_MS);
        try {
          response = await callBailian(retryController.signal);
          clearTimeout(retryTimeout);
        } catch (retryErr) {
          clearTimeout(retryTimeout);
          res.send({ code: 500, msg: "AI 服务繁忙，请稍后重试" });
          return;
        }
        if (!response.ok) {
          res.send({ code: 500, msg: `AI 服务错误 (${response.status})` });
          return;
        }
      } else {
        res.send({ code: 500, msg: `AI 服务错误 (${response.status})` });
        return;
      }
    }
    const rawText = await response.text();
    let result;
    let aiText;
    try {
      result = JSON.parse(rawText);
      aiText =
        result.output?.text ||
        result.output?.choices?.[0]?.message?.content ||
        result.data?.output?.text ||
        result.choices?.[0]?.message?.content;
    } catch (e) {
      // 如果不是 JSON，假设是纯文本响应
      aiText = rawText.trim();
    }
    if (aiText) {
      const finalData = shareSummary
        ? `【基于学生分享的总结】\n\n${shareSummary}\n\n【综合回答】\n\n${aiText}`
        : aiText;
      res.send({ code: 200, data: finalData });
    } else {
      res.send({ code: 500, msg: "AI 未返回有效内容" });
    }
  } catch (error) {
    console.error("智能查询失败:", error);
    res.send({ code: 500, msg: "智能查询失败: " + (error.message || String(error)) });
  }
});

/** 本地模拟 AI 回复（未配置百炼时可用）：根据选科/分享拼一段示例文案 */
function generateMockResponse(prompt, profileSummary, shareEntries, isXuanke, xuankeContext) {
  const safePrompt = (prompt || "").trim();
  const hasShare = shareEntries && shareEntries.length > 0;

  if (isXuanke && xuankeContext) {
    const combo = [xuankeContext.first, ...xuankeContext.second].filter(Boolean).join("+") || "（未选）";
    return `针对选科问题「${safePrompt.slice(0, 50)}${safePrompt.length > 50 ? "…" : ""}」整理如下：

1. **当前选科组合**
   - 首选：${xuankeContext.first || "未选"}；再选：${xuankeContext.second?.length ? xuankeContext.second.join("、") : "未选"}（组合：${combo}）
   - 省份：${xuankeContext.province || "未填"}（各省选科要求略有差异，以本省考试院为准）

2. **专业限报与科目要求（示例）**
   - 临床医学类：多数要求「物理+化学」或「物理+化学+生物」；
   - 计算机类、电子信息类：多数要求选「物理」；
   - 文史哲、法学、经管等：部分仅要求「历史」或「物理/历史均可」；
   - 具体以各校当年招生简章及本省《普通高校招生专业选考科目要求》为准。

3. **建议**
   - 若已选「物化生」：可报绝大多数理工医类专业，部分文史类专业可能限历史；
   - 若选「历史+……」：重点核对目标专业是否限物理，避免误报；
   - 新高考省份请务必查阅本省考试院公布的选科要求对照表。

> 选科要求每年可能微调，填报前请以当年官方发布为准。`;
  }

  let base = safePrompt.length > 0
    ? `针对你的问题「${safePrompt.slice(0, 40)}${safePrompt.length > 40 ? "…" : ""}」，结合现有资料整理如下：`
    : "以下为演示用的综合回答示例：";

  let body = "";

  if (hasShare) {
    body += `
1. **来自在读同学的分享（供参考）**
${shareEntries
  .slice(0, 4)
  .map(
    (e) =>
      `   - **${e.school || "某校"}**（${e.major || "-"}）：${(e.experience || "").slice(0, 80)}${(e.experience || "").length > 80 ? "…" : ""}`
  )
  .join("\n")}
`;
  }

  body += `
${hasShare ? "2" : "1"}. **招生与录取信息（示例，实际需对接招生简章数据）**
   - 招生计划、录取线、批次等信息建议查阅该校当年招生简章或省考试院官网；
   - 转专业、大类分流等政策以学校官网为准。

${hasShare ? "3" : "2"}. **志愿搭配建议**
   - 「保底」：选 1～2 所近年录取分明显低于你分数线的院校；
   - 「稳妥」：安排 3～4 所与你分数接近、专业匹配的院校；
   - 「冲刺」：预留 1～2 所略高于你分数的目标院校。

> 以上综合了在读分享${hasShare ? "与" : ""}招生信息。正式填报请以当年官方招生简章和投档线为准。
`;

  return base + body;
}

// ========== 功能4：保存学生长篇分享（旧接口，匿名） ==========
app.post('/save-student-share', (req, res) => {
  const { school, major, grade, title, content, tags } = req.body;
  
  if (!school || !major || !title || !content) {
    res.send({ code: 400, msg: "请填写完整信息" });
    return;
  }
  
  const sql = `INSERT INTO student_shares (school, major, grade, title, content, tags, status) VALUES (?, ?, ?, ?, ?, ?, 'approved')`;
  db.run(sql, [school, major, grade || '未知年级', title, content, tags || ''], function(err) {
    if (err) {
      console.error("保存学生分享失败:", err);
      res.send({ code: 500, msg: "保存失败" });
      return;
    }
    res.send({ code: 200, msg: "分享提交成功！", id: this.lastID });
  });
});

// ========== 功能5：获取学生长篇分享列表（旧接口） ==========
app.get('/get-student-shares', (req, res) => {
  const sql = `SELECT * FROM student_shares WHERE status = 'approved' ORDER BY upload_time DESC`;
  db.all(sql, [], (err, rows) => {
    if (err) {
      console.error("获取学生分享失败:", err);
      res.send({ code: 500, msg: "获取失败" });
      return;
    }
    res.send({ code: 200, data: rows });
  });
});

// ========== 专业概览与开设院校、专业动态（表结构） ==========
// 表结构由 initMySQLForKeywords() 在连接 MySQL 时统一创建（major_overviews / school_programs / major_news），
// 不再在此处执行 CREATE/ALTER，避免与 MySQL 初始化顺序冲突及 SQLite 语法误用于 MySQL。

// ----- 管理员校验：请求体里带正确 password 才放行 -----
const ADMIN_PASSWORD = 'a~a~ycyzword+';
function verifyAdmin(req, res, next) {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) {
    res.send({ code: 403, msg: "密码错误，无权限访问" });
    return;
  }
  next();  // 通过则交给下一个处理函数
}

// ========== 管理后台接口（需密码或 query/body 里的 password） ==========

// 下载数据库备份文件（方便本机保存）
app.get('/admin/backup/download-db', (req, res) => {
  const pwd = req.query.password || (req.body && req.body.password);
  if (pwd !== ADMIN_PASSWORD) {
    res.status(403).send('无权限');
    return;
  }
  // Vercel 无本地数据库文件，数据在 MySQL，此接口不可用
  if (process.env.VERCEL) {
    res.status(501).json({ code: 501, msg: '备份下载在 Vercel 环境下不可用，请从 MySQL 导出或使用自建服务器备份。' });
    return;
  }
  if (!fs.existsSync(DB_PATH)) {
    res.status(404).send('数据库文件不存在');
    return;
  }
  res.setHeader('Content-Disposition', 'attachment; filename="study_experience.db"');
  res.setHeader('Content-Type', 'application/octet-stream');
  fs.createReadStream(DB_PATH).pipe(res);
});

// 待人工审核的学生证列表
app.get('/admin/student-id-pending', (req, res) => {
  const pwd = req.query.password || (req.body && req.body.password);
  if (pwd !== ADMIN_PASSWORD) {
    res.send({ code: 403, msg: "无权限" });
    return;
  }
  db.all(
    'SELECT id, school_name, status, created_at FROM student_id_verifications WHERE status = ? ORDER BY created_at DESC',
    ['pending_manual'],
    (err, rows) => {
      if (err) {
        res.send({ code: 500, msg: "获取失败" });
        return;
      }
      res.send({ code: 200, data: rows });
    }
  );
});

// 查看某条学生证图片（base64，用于人工审核）
app.get('/admin/student-id-pending/:id', (req, res) => {
  const pwd = req.query.password;
  if (pwd !== ADMIN_PASSWORD) {
    res.send({ code: 403, msg: "无权限" });
    return;
  }
  db.get('SELECT id, school_name, image_data, status, created_at FROM student_id_verifications WHERE id = ?', [req.params.id], (err, row) => {
    if (err || !row) {
      res.send({ code: 404, msg: "记录不存在" });
      return;
    }
    res.send({ code: 200, data: { id: row.id, school_name: row.school_name, status: row.status, created_at: row.created_at, imageDataUrl: row.image_data ? 'data:image/jpeg;base64,' + row.image_data : null } });
  });
});

// 通过或拒绝学生证（verifyAdmin 会先校验密码）
app.post('/admin/student-id-review', verifyAdmin, (req, res) => {
  const { id, action } = req.body;
  if (!id || !['approve', 'reject'].includes(action)) {
    res.send({ code: 400, msg: "参数错误" });
    return;
  }
  db.get('SELECT id, school_name, status, nickname FROM student_id_verifications WHERE id = ?', [id], (err, row) => {
    if (err || !row) {
      res.send({ code: 404, msg: "记录不存在" });
      return;
    }
    if (row.status !== 'pending_manual') {
      res.send({ code: 400, msg: "该记录已处理" });
      return;
    }
    if (action === 'reject') {
      db.run('UPDATE student_id_verifications SET status = ? WHERE id = ?', ['rejected', id], (e) => {
        res.send(e ? { code: 500, msg: "操作失败" } : { code: 200, msg: "已拒绝" });
      });
      return;
    }
    const authToken = require('crypto').randomBytes(32).toString('hex');
    const tokenExpiresAt = new Date(Date.now() + TOKEN_EXPIRY_MS).toISOString();
    const sid = 'sid_' + id;
    const nick = (row.nickname || '').trim() || '在读生';
    db.run(
      'UPDATE student_id_verifications SET status = ?, auth_token = ?, token_expires_at = ? WHERE id = ?',
      ['approved', authToken, toMySQLDateTime(tokenExpiresAt), id],
      (e) => {
        if (e) {
          console.error('学生证通过-UPDATE失败:', e);
          res.send({ code: 500, msg: "操作失败" });
          return;
        }
        const insertCb = (e2) => {
          if (e2) {
            console.error('学生证通过-INSERT verified_users失败:', e2.message);
            if (String(e2.message).includes('duplicate') || String(e2.message).includes('UNIQUE')) {
              return res.send({ code: 200, msg: "已通过（该用户已认证）", authToken });
            }
            db.run(
              'REPLACE INTO verified_users (email, school_name, auth_type, auth_token, token_expires_at, nickname) VALUES (?, ?, ?, ?, ?, ?)',
              [sid, row.school_name, 'student_id', authToken, toMySQLDateTime(tokenExpiresAt), nick],
              (e3) => {
                if (e3) console.error('学生证通过-REPLACE verified_users 失败:', e3.message);
                res.send(e3 ? { code: 500, msg: "写入用户表失败，请查看服务端日志" } : { code: 200, msg: "已通过", authToken });
              }
            );
            return;
          }
          res.send({ code: 200, msg: "已通过", authToken });
        };
        db.run(
          'REPLACE INTO verified_users (email, school_name, auth_type, auth_token, token_expires_at, nickname) VALUES (?, ?, ?, ?, ?, ?)',
          [sid, row.school_name, 'student_id', authToken, toMySQLDateTime(new Date(Date.now() + TOKEN_EXPIRY_MS)), nick],
          insertCb
        );
      }
    );
  });
});

// 被举报待审核的帖子列表（举报数>50 会变成 pending_review）
app.get('/admin/reported-shares', (req, res) => {
  const pwd = req.query.password || (req.body && req.body.password);
  if (pwd !== ADMIN_PASSWORD) {
    res.send({ code: 403, msg: "无权限" });
    return;
  }
  db.all(
    `SELECT s.id, s.school, s.major, s.title, s.content, s.upload_time, s.status,
      (SELECT COUNT(*) FROM share_reports r WHERE r.share_id = s.id) AS report_count
     FROM student_shares s WHERE s.status = 'pending_review' ORDER BY report_count DESC, s.upload_time DESC`,
    [],
    (err, rows) => {
      if (err) {
        res.send({ code: 500, msg: "获取失败" });
        return;
      }
      res.send({ code: 200, data: rows });
    }
  );
});

// 删帖（将 status 改为 deleted）
app.post('/admin/student-shares/:id/delete', verifyAdmin, (req, res) => {
  const id = req.params.id;
  db.run("UPDATE student_shares SET status = 'deleted' WHERE id = ?", [id], function (err) {
    if (err) {
      res.send({ code: 500, msg: "操作失败" });
      return;
    }
    res.send({ code: 200, msg: this.changes ? "已删除" : "记录不存在或已删除" });
  });
});

// 通过待审帖子（改为 approved 后公开展示）
app.post('/admin/student-shares/:id/approve', verifyAdmin, (req, res) => {
  const id = req.params.id;
  db.run("UPDATE student_shares SET status = 'approved' WHERE id = ? AND status = 'pending_review'", [id], function (err) {
    if (err) {
      res.send({ code: 500, msg: "操作失败" });
      return;
    }
    res.send({ code: 200, msg: this.changes ? "已通过，帖子将公开展示" : "记录不存在或已处理" });
  });
});

// --- 专业概览 CRUD（管理员） ---
app.get('/admin/majors', (req, res) => {
  const sql = `SELECT * FROM major_overviews ORDER BY category, major_name`;
  db.all(sql, [], (err, rows) => {
    if (err) {
      console.error("获取专业列表失败:", err);
      res.send({ code: 500, msg: "获取失败" });
      return;
    }
    res.send({ code: 200, data: rows });
  });
});

app.post('/admin/majors', verifyAdmin, (req, res) => {
  const { password, major_code, major_name, category, degree_type, duration, description, core_courses, career_prospects, related_majors } = req.body;
  
  const sql = `INSERT INTO major_overviews (major_code, major_name, category, degree_type, duration, description, core_courses, career_prospects, related_majors) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  db.run(sql, [major_code, major_name, category, degree_type, duration, description, core_courses, career_prospects, related_majors], function(err) {
    if (err) {
      console.error("添加专业失败:", err);
      res.send({ code: 500, msg: "添加失败: " + err.message });
      return;
    }
    res.send({ code: 200, msg: "添加成功", id: this.lastID });
  });
});

// 更新专业
app.put('/admin/majors/:id', verifyAdmin, (req, res) => {
  const { password, major_code, major_name, category, degree_type, duration, description, core_courses, career_prospects, related_majors } = req.body;
  const id = req.params.id;
  
  const sql = `UPDATE major_overviews SET major_code = ?, major_name = ?, category = ?, degree_type = ?, duration = ?, description = ?, core_courses = ?, career_prospects = ?, related_majors = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`;
  db.run(sql, [major_code, major_name, category, degree_type, duration, description, core_courses, career_prospects, related_majors, id], function(err) {
    if (err) {
      console.error("更新专业失败:", err);
      res.send({ code: 500, msg: "更新失败: " + err.message });
      return;
    }
    res.send({ code: 200, msg: "更新成功" });
  });
});

// 删除专业
app.delete('/admin/majors/:id', verifyAdmin, (req, res) => {
  const { password } = req.body;
  const id = req.params.id;
  
  const sql = `DELETE FROM major_overviews WHERE id = ?`;
  db.run(sql, [id], function(err) {
    if (err) {
      console.error("删除专业失败:", err);
      res.send({ code: 500, msg: "删除失败" });
      return;
    }
    res.send({ code: 200, msg: "删除成功" });
  });
});

// 获取某专业的开设院校
app.get('/admin/majors/:id/programs', (req, res) => {
  const majorId = req.params.id;
  const sql = `SELECT * FROM school_programs WHERE major_id = ? ORDER BY school_name`;
  db.all(sql, [majorId], (err, rows) => {
    if (err) {
      console.error("获取开设院校失败:", err);
      res.send({ code: 500, msg: "获取失败" });
      return;
    }
    res.send({ code: 200, data: rows });
  });
});

// 添加开设院校
app.post('/admin/programs', verifyAdmin, (req, res) => {
  const { password, major_id, school_name, school_level, location, program_features, courses, admission_requirements, tuition_fee, scholarships, contact_info } = req.body;
  
  const sql = `INSERT INTO school_programs (major_id, school_name, school_level, location, program_features, courses, course_intros, admission_requirements, tuition_fee, scholarships, contact_info) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  db.run(sql, [major_id, school_name, school_level, location, program_features, courses, '', admission_requirements, tuition_fee, scholarships, contact_info], function(err) {
    if (err) {
      console.error("添加开设院校失败:", err);
      res.send({ code: 500, msg: "添加失败: " + err.message });
      return;
    }
    res.send({ code: 200, msg: "添加成功", id: this.lastID });
  });
});

// 更新开设院校
app.put('/api/admin/programs/:id', verifyAdmin, (req, res) => {
  const { password, school_name, school_level, location, program_features, courses, admission_requirements, tuition_fee, scholarships, contact_info } = req.body;
  const id = req.params.id;
  
  const sql = `UPDATE school_programs SET school_name = ?, school_level = ?, location = ?, program_features = ?, courses = ?, admission_requirements = ?, tuition_fee = ?, scholarships = ?, contact_info = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`;
  db.run(sql, [school_name, school_level, location, program_features, courses, admission_requirements, tuition_fee, scholarships, contact_info, id], function(err) {
    if (err) {
      console.error("更新开设院校失败:", err);
      res.send({ code: 500, msg: "更新失败: " + err.message });
      return;
    }
    res.send({ code: 200, msg: "更新成功" });
  });
});

// 删除开设院校
app.delete('/api/admin/programs/:id', verifyAdmin, (req, res) => {
  const { password } = req.body;
  const id = req.params.id;
  
  const sql = `DELETE FROM school_programs WHERE id = ?`;
  db.run(sql, [id], function(err) {
    if (err) {
      console.error("删除开设院校失败:", err);
      res.send({ code: 500, msg: "删除失败" });
      return;
    }
    res.send({ code: 200, msg: "删除成功" });
  });
});

// 获取某专业的动态趣闻（管理后台用）
app.get('/api/admin/majors/:id/news', (req, res) => {
  const majorId = req.params.id;
  const sql = `SELECT * FROM major_news WHERE major_id = ? ORDER BY is_hot DESC, created_at DESC`;
  db.all(sql, [majorId], (err, rows) => {
    if (err) {
      console.error("获取专业动态失败:", err);
      res.send({ code: 500, msg: "获取失败" });
      return;
    }
    res.send({ code: 200, data: rows });
  });
});

// 添加专业动态趣闻
app.post('/api/admin/news', verifyAdmin, (req, res) => {
  const { password, major_id, title, content, source, publish_date, is_hot } = req.body;
  
  const sql = `INSERT INTO major_news (major_id, title, content, source, publish_date, is_hot) VALUES (?, ?, ?, ?, ?, ?)`;
  db.run(sql, [major_id, title, content, source, publish_date, toTinyInt(is_hot)], function(err) {
    if (err) {
      console.error("添加专业动态失败:", err);
      res.send({ code: 500, msg: "添加失败: " + err.message });
      return;
    }
    res.send({ code: 200, msg: "添加成功", id: this.lastID });
  });
});

// 更新专业动态趣闻
app.put('/api/admin/news/:id', verifyAdmin, (req, res) => {
  const { password, title, content, source, publish_date, is_hot } = req.body;
  const id = req.params.id;
  
  const sql = `UPDATE major_news SET title = ?, content = ?, source = ?, publish_date = ?, is_hot = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`;
  db.run(sql, [title, content, source, publish_date, toTinyInt(is_hot), id], function(err) {
    if (err) {
      console.error("更新专业动态失败:", err);
      res.send({ code: 500, msg: "更新失败: " + err.message });
      return;
    }
    res.send({ code: 200, msg: "更新成功" });
  });
});

// 删除专业动态趣闻
app.delete('/api/admin/news/:id', verifyAdmin, (req, res) => {
  const { password } = req.body;
  const id = req.params.id;
  
  const sql = `DELETE FROM major_news WHERE id = ?`;
  db.run(sql, [id], function(err) {
    if (err) {
      console.error("删除专业动态失败:", err);
      res.send({ code: 500, msg: "删除失败" });
      return;
    }
    res.send({ code: 200, msg: "删除成功" });
  });
});

// ========== 公开 API（无需管理员密码） ==========
// 获取所有专业概览，供前端展示
app.get('/api/majors', (req, res) => {
  const sql = `SELECT * FROM major_overviews ORDER BY category, major_name`;
  db.all(sql, [], (err, rows) => {
    if (err) {
      console.error("获取专业列表失败:", err);
      res.send({ code: 500, msg: "获取失败" });
      return;
    }
    res.send({ code: 200, data: rows });
  });
});

// 获取某专业详情 + 该专业在各校的开设情况
app.get('/api/majors/:id', (req, res) => {
  const majorId = req.params.id;
  
  db.get(`SELECT * FROM major_overviews WHERE id = ?`, [majorId], (err, major) => {
    if (err || !major) {
      res.send({ code: 404, msg: "专业不存在" });
      return;
    }
    
    db.all(`SELECT * FROM school_programs WHERE major_id = ? ORDER BY school_name`, [majorId], (err, programs) => {
      if (err) {
        res.send({ code: 500, msg: "获取失败" });
        return;
      }
      res.send({ code: 200, data: { ...major, programs } });
    });
  });
});

// 按关键词搜索专业（GET/POST 都支持，keyword 在 query 或 body 里）
const searchMajorsByKeyword = (keyword, res) => {
  const k = (keyword && String(keyword).trim()) || '';
  if (!k) {
    res.send({ code: 400, msg: "请输入关键词" });
    return;
  }
  const sql = `SELECT * FROM major_overviews WHERE major_name LIKE ? OR category LIKE ? ORDER BY major_name`;
  db.all(sql, [`%${k}%`, `%${k}%`], (err, rows) => {
    if (err) {
      console.error("搜索专业失败:", err);
      res.send({ code: 500, msg: "搜索失败" });
      return;
    }
    res.send({ code: 200, data: rows || [] });
  });
};
app.get('/api/majors/search', (req, res) => {
  searchMajorsByKeyword(req.query.keyword, res);
});
app.post('/api/majors/search', (req, res) => {
  searchMajorsByKeyword(req.body && req.body.keyword, res);
});

// ========== 学生分享 API（新） ==========
// 获取列表：支持 school/major/keyword 筛选；带点赞数；过滤无用/情绪化/到期删除的；有 token/guestId 时带 user_has_liked
app.get('/api/student-shares', async (req, res) => {
  db.run(`UPDATE student_shares SET status = 'deleted' WHERE delete_after IS NOT NULL AND delete_after <= NOW()`, () => {});
  const { school, major, keyword } = req.query;
  let sql = `SELECT s.*, (SELECT COUNT(*) FROM share_likes sl WHERE sl.share_id = s.id) AS like_count FROM student_shares s WHERE s.status = 'approved'
    AND (s.usefulness_ratio IS NULL OR s.usefulness_ratio >= 40)
    AND (s.is_emotional IS NULL OR s.is_emotional = 0)
    AND (s.delete_after IS NULL OR s.delete_after > NOW())`;
  const params = [];

  if (school) {
    sql += ` AND s.school = ?`;
    params.push(school);
  }

  if (major) {
    sql += ` AND s.major = ?`;
    params.push(major);
  }

  if (keyword) {
    sql += ` AND (s.title LIKE ? OR s.content LIKE ? OR s.tags LIKE ?)`;
    params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
  }

  sql += ` ORDER BY s.upload_time DESC`;

  db.all(sql, params, async (err, rows) => {
    if (err) {
      console.error("获取学生分享失败:", err);
      res.send({ code: 500, msg: "获取失败" });
      return;
    }
  const token = getTokenFromRequest(req);
  const verified = await parseAuthToken(token || null);
  const guestId = (req.query && req.query.guestId != null) ? String(req.query.guestId).trim() : '';
  let userEmail = verified ? verified.email : (guestId ? 'guest_' + guestId : null);
  if (!userEmail && token) userEmail = 'token_' + require('crypto').createHash('sha256').update(String(token)).digest('hex').slice(0, 32);
  if (userEmail && rows && rows.length > 0) {
    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => '?').join(',');
    const liked = await new Promise((resolve) => {
      db.all(`SELECT share_id FROM share_likes WHERE share_id IN (${placeholders}) AND user_email = ?`, [...ids, userEmail], (e, r) => resolve(e ? [] : (r || []).map((x) => x.share_id)));
    });
    rows.forEach((r) => { r.user_has_liked = liked.indexOf(r.id) !== -1; });
  } else {
    rows.forEach((r) => { r.user_has_liked = false; });
  }
  res.send({ code: 200, data: rows });
  });
});

// 按分享编号读取单条帖子（share_number 即 id，用于前端固定链接）
app.get('/api/student-shares/by-number/:share_number', (req, res) => {
  const shareNumber = parseInt(String(req.params.share_number), 10);
  if (Number.isNaN(shareNumber) || shareNumber < 1) {
    res.send({ code: 400, msg: "编号无效" });
    return;
  }
  db.get(
    `SELECT s.*, (SELECT COUNT(*) FROM share_likes sl WHERE sl.share_id = s.id) AS like_count FROM student_shares s WHERE s.share_number = ?`,
    [shareNumber],
    (err, row) => {
      if (err) {
        res.send({ code: 500, msg: "查询失败" });
        return;
      }
      if (!row) {
        res.send({ code: 404, msg: "未找到该编号的帖子" });
        return;
      }
      res.send({ code: 200, data: row });
    }
  );
});

// 多张图片存一个字段时用此分隔符（因为 base64 里本身有逗号）
const IMAGE_SEP = '|||IMAGE_SEP|||';

// ========== 信息认证：学校邮箱验证 + 学生证 ==========
// 邮箱后缀 -> 学校名映射（DeepSeek 识别失败时的回退表）
const EMAIL_SUFFIX_TO_SCHOOL = {
  'pku.edu.cn': '北京大学',
  'tsinghua.edu.cn': '清华大学',
  'fudan.edu.cn': '复旦大学',
  'sjtu.edu.cn': '上海交通大学',
  'zju.edu.cn': '浙江大学',
  'nju.edu.cn': '南京大学',
  'ustc.edu.cn': '中国科学技术大学',
  'whu.edu.cn': '武汉大学',
  'nankai.edu.cn': '南开大学',
  'ruc.edu.cn': '中国人民大学',
  'tongji.edu.cn': '同济大学',
  'xmu.edu.cn': '厦门大学',
  'sysu.edu.cn': '中山大学',
  'scu.edu.cn': '四川大学',
  'hit.edu.cn': '哈尔滨工业大学',
  'buaa.edu.cn': '北京航空航天大学',
  'bupt.edu.cn': '北京邮电大学',
  'bit.edu.cn': '北京理工大学',
  'njupt.edu.cn': '南京邮电大学',
  'seu.edu.cn': '东南大学'
};

/** 根据邮箱后缀得到学校名：有 DeepSeek 就用 AI，否则查上面内置表 */
async function getSchoolFromEmailSuffix(emailSuffix) {
  const suffixLower = (emailSuffix || '').trim().toLowerCase();
  if (suffixLower && EMAIL_SUFFIX_TO_SCHOOL[suffixLower])
    return EMAIL_SUFFIX_TO_SCHOOL[suffixLower];

  if (!DEEPSEEK_API_KEY)
    return EMAIL_SUFFIX_TO_SCHOOL[suffixLower] || '未知';

  const prompt = `请根据中国高校邮箱后缀判断对应的学校中文名称。例如：pku.edu.cn -> 北京大学；tsinghua.edu.cn -> 清华大学；fudan.edu.cn -> 复旦大学。
邮箱后缀：${emailSuffix}
只返回学校的中文全称，不要任何标点、解释或换行。如果无法确定，返回"未知"`;
  const systemPrompt = '你是一个教育数据助手。根据邮箱后缀准确识别中国大陆高校中文名称。';
  try {
    const result = await callDeepSeekAI(prompt, systemPrompt);
    let name = (result || '').trim();
    // 取第一行或冒号后的内容
    const firstLine = name.split(/\n/)[0].trim();
    const afterColon = (firstLine.includes('：') ? firstLine.split('：').pop() : firstLine) || (firstLine.includes(':') ? firstLine.split(':').pop() : firstLine);
    name = (afterColon || firstLine).trim().replace(/^["']|["']$/g, '').replace(/[\n\r]/g, '').replace(/[。，、]+$/g, '').trim();
    if (name && name !== '未知') return name;
  } catch (e) {
    console.error("邮箱后缀识别学校失败:", e);
  }
  return EMAIL_SUFFIX_TO_SCHOOL[suffixLower] || '未知';
}

// GET 后端配置检查（不暴露密钥）：用于确认当前请求是否到达正确后端及 SMTP/百炼 是否已配置
app.get('/api/auth/backend-config', (req, res) => {
  res.send({
    code: 200,
    smtpConfigured: !!transporter,
    bailianConfigured: !!BAILIAN_API_KEY,
    msg: 'OK'
  });
});

// POST 发送验证码：校验学校邮箱，生成 6 位码存库，由 SMTP 发送邮件（须配置 SMTP_PASS）
app.post('/api/auth/send-code', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  if (!email) {
    res.send({ code: 400, msg: "请输入学校邮箱" });
    return;
  }
  const suffix = email.split('@')[1] || '';
  if (!suffix.endsWith('.edu') && !suffix.endsWith('.edu.cn')) {
    res.send({ code: 400, msg: "请使用学校邮箱（以 .edu 或 .edu.cn 结尾）" });
    return;
  }

  const emailMasked = email.replace(/(.{3})(.*)(@.*)/, '$1***$3');

  try {
    await initMySQLForKeywords();
  } catch (mysqlErr) {
    console.error("[邮件] MySQL 未就绪，无法保存验证码:", mysqlErr.message);
    res.send({ code: 503, msg: "服务暂不可用，请稍后重试" });
    return;
  }

  const schoolName = await getSchoolFromEmailSuffix(suffix);
  const code = String(Math.floor(100000 + Math.random() * 900000));
  // 用 MySQL 的 NOW() 生成过期时间，避免 Node 与 MySQL 时区不一致导致「验证码已过期」
  try {
    await mysqlPool.execute(
      'INSERT INTO verification_codes (email, code, school_name, expires_at) VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 5 MINUTE))',
      [email, code, schoolName]
    );
  } catch (err) {
    console.error("保存验证码失败:", err);
    res.send({ code: 500, msg: "发送失败" });
    return;
  }

  console.log("[邮件] 正在发送验证码至", emailMasked, "学校:", schoolName);
  const mailResult = await sendVerifyEmail(email, code);
  if (mailResult.success) {
    res.send({ code: 200, msg: "验证码已发送到您的邮箱", school: schoolName });
    return;
  }
  if (mailResult.testMode) {
    res.send({ code: 200, msg: "当前为测试模式，验证码已记录到服务器日志", school: schoolName });
    return;
  }
  const msg = (mailResult.error && mailResult.error.message) || mailResult.msg || "邮件发送失败";
  const codeNum = mailResult.error && (mailResult.error.responseCode || mailResult.error.code);
  let userMsg = "邮件发送失败，请稍后重试";
  if (codeNum === 535 || /authentication|auth|login|535/i.test(String(msg))) {
    userMsg = "SMTP 认证失败，请检查 SMTP 授权码（163 邮箱需使用「授权码」而非登录密码）";
  } else if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND/i.test(String(msg))) {
    userMsg = "无法连接邮件服务器，请检查 SMTP 地址与端口";
  } else if (/recipient|550|553/i.test(String(msg))) {
    userMsg = "收件地址被拒绝，请确认邮箱正确";
  }
  res.send({ code: 500, msg: userMsg });
});

// POST 验证码校验：正确则写入 verified_users 并返回 authToken，用于后续发帖等
app.post('/api/auth/verify', (req, res) => {
  const { email, code, nickname } = req.body;
  const emailLower = (email || '').trim().toLowerCase();
  const codeStr = String(code || '').trim();
  const nick = (nickname || '').trim() || '在读生';

  if (!emailLower || !codeStr) {
    res.send({ code: 400, msg: "请输入邮箱和验证码" });
    return;
  }

  db.get(
    'SELECT school_name FROM verification_codes WHERE email = ? AND code = ? AND expires_at > NOW() ORDER BY id DESC LIMIT 1',
    [emailLower, codeStr],
    (err, row) => {
      if (err || !row) {
        res.send({ code: 400, msg: "验证码错误或已过期" });
        return;
      }
      const schoolName = row.school_name || '未知';
      const authToken = require('crypto').randomBytes(32).toString('hex');
      const tokenExpiresAt = new Date(Date.now() + TOKEN_EXPIRY_MS).toISOString();

      // 先插入必填列，避免因 nickname 列未就绪导致失败；再单独更新昵称
      db.run(
        'INSERT INTO verified_users (email, school_name, auth_type, auth_token, token_expires_at) VALUES (?, ?, ?, ?, ?)',
        [emailLower, schoolName, 'email', authToken, toMySQLDateTime(tokenExpiresAt)],
        function (replaceErr) {
          if (replaceErr) {
            res.send({ code: 500, msg: "认证失败" });
            return;
          }
          db.run('UPDATE verified_users SET nickname = ? WHERE auth_token = ?', [nick, authToken], () => {});
          res.send({
            code: 200,
            msg: "认证成功",
            authToken,
            school: schoolName,
            nickname: nick,
            expiresAt: tokenExpiresAt
          });
        }
      );
    }
  );
});

/** 学生证图片用百炼千问视觉模型鉴伪，返回 'pass' | 'rejected' | 'review'（存疑转人工）；与志愿查询共用 BAILIAN_API_KEY */
async function callBailianVisionStudentId(imageBase64) {
  if (!BAILIAN_API_KEY) {
    console.warn('[学生证鉴伪] 未配置 BAILIAN_API_KEY，直接转人工审核');
    return 'review';
  }
  const fetch = (await import('node-fetch')).default;
  const imageUrl = imageBase64.startsWith('data:') ? imageBase64 : `data:image/jpeg;base64,${imageBase64}`;
  try {
    const response = await fetch(`${DASHSCOPE_BASE}/compatible-mode/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${BAILIAN_API_KEY}`
      },
      body: JSON.stringify({
        model: DASHSCOPE_VISION_MODEL,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: '请判断这张图片是否为真实的学生证/校园卡照片（含学校名称、个人信息等）。仅回答一个字：是 或 否。' },
              { type: 'image_url', image_url: { url: imageUrl } }
            ]
          }
        ],
        max_tokens: 50
      })
    });
    const rawBody = await response.text();
    if (!response.ok) {
      console.warn('[学生证鉴伪] 百炼视觉 API 非 200:', response.status, rawBody.slice(0, 400));
      return 'review';
    }
    let result;
    try {
      result = JSON.parse(rawBody);
    } catch (e) {
      console.warn('[学生证鉴伪] 百炼返回非 JSON:', rawBody.slice(0, 200));
      return 'review';
    }
    const text = (result.choices?.[0]?.message?.content || result.output?.text || result.output?.choices?.[0]?.message?.content || '').trim();
    console.log('[学生证鉴伪] 百炼返回原文:', JSON.stringify(text).slice(0, 200));
    if (!text) {
      console.warn('[学生证鉴伪] 未解析到文本，响应结构:', JSON.stringify(result).slice(0, 300));
    }
    if (/^是|真实|有效|学生证|确认为?真/.test(text) && !/否|不真实|假|非学生证/.test(text)) return 'pass';
    if (/是/.test(text) && !/否|不真实|假|非学生证/.test(text)) return 'pass';
    if (/yes|true|real/.test(text.toLowerCase()) && !/no|false|假|非学生证|不真实/.test(text)) return 'pass';
    if (/^否|不真实|假|非学生证/.test(text)) return 'rejected';
    if (/否|不真实|假|非学生证|no|false/.test(text)) return 'rejected';
    console.warn('[学生证鉴伪] 模型输出无法判定，转人工:', JSON.stringify(text).slice(0, 100));
  } catch (e) {
    console.error('[学生证鉴伪] 请求异常:', e.message);
  }
  return 'review';
}

/** 百炼文本审核：判断标题+内容+标签是否违规，返回 'pass' | 'block' | 'review'；与志愿查询共用 BAILIAN_API_KEY */
async function callBailianTextModeration(title, content, tags) {
  if (!BAILIAN_API_KEY) return 'review';
  const fetch = (await import('node-fetch')).default;
  const text = [title, content, tags].filter(Boolean).join('\n').slice(0, 3000);
  if (!text.trim()) return 'pass';
  try {
    const response = await fetch(`${DASHSCOPE_BASE}/compatible-mode/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${BAILIAN_API_KEY}`
      },
      body: JSON.stringify({
        model: 'qwen-turbo',
        messages: [
          {
            role: 'system',
            content: '你是一个内容安全审核助手。仅根据规则判断用户输入是否违规。违规包括：色情低俗、暴力恐怖、违法信息、人身攻击、恶意广告、违禁品等。仅回答 exactly 以下之一：通过、违规、无法判断。不要解释。'
          },
          {
            role: 'user',
            content: `请判断以下内容是否违规：\n${text}`
          }
        ],
        max_tokens: 20
      })
    });
    if (!response.ok) return 'review';
    const result = await response.json();
    const answer = (result.choices?.[0]?.message?.content || result.output?.text || '').trim();
    if (/通过|合规|正常/.test(answer) && !/违规|不通过/.test(answer)) return 'pass';
    if (/违规|不通过|违禁|拒绝/.test(answer)) return 'block';
  } catch (e) {
    console.error('百炼文本审核失败:', e.message);
  }
  return 'review';
}

// 阿里云内容安全（可选）：学生证图片鉴伪，环境变量 ALIYUN_* 或 ALIBABA_CLOUD_*
const ALIYUN_ACCESS_KEY_ID = process.env.ALIYUN_ACCESS_KEY_ID || process.env.ALIBABA_CLOUD_ACCESS_KEY_ID;
const ALIYUN_ACCESS_KEY_SECRET = process.env.ALIYUN_ACCESS_KEY_SECRET || process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET;
const ALIYUN_GREEN_REGION = process.env.ALIYUN_GREEN_REGION || 'cn-shanghai';
if (ALIYUN_ACCESS_KEY_ID && ALIYUN_ACCESS_KEY_SECRET) {
  console.log('✅ 阿里云内容安全已配置；学生证认证因使用 base64 上传，/green/image/scan 仅支持 URL，故学生证鉴伪仅使用百炼视觉');
} else {
  console.warn('⚠️ 未配置 ALIYUN_ACCESS_KEY_ID/ALIYUN_ACCESS_KEY_SECRET，学生证仅走百炼鉴伪或人工审核');
}

// POST 学生证认证：上传图片 → 百炼视觉鉴伪 → 可选阿里云审核 → 通过则写 verified_users 并返回 token
app.post('/api/auth/student-id', async (req, res) => {
  const { school, imageBase64, nickname } = req.body;
  const schoolName = (school || '').trim();
  const nick = (nickname || '').trim() || '在读生';
  console.log('[学生证] 认证请求 received, school=', schoolName, 'imageSize=', (imageBase64 && imageBase64.length) || 0);
  if (!schoolName) {
    res.send({ code: 400, msg: "请选择学校" });
    return;
  }
  const rawBase64 = (imageBase64 || '').replace(/^data:image\/\w+;base64,/, '');
  if (!rawBase64 || rawBase64.length > 4 * 1024 * 1024) {
    res.send({ code: 400, msg: "请上传学生证图片（不超过约 3MB）" });
    return;
  }

  let status = 'pending_manual';
  // 1) 学生证图片发给 AI（百炼千问视觉）鉴伪
  try {
    const aiResult = await callBailianVisionStudentId(rawBase64);
    console.log('[学生证] 百炼鉴伪结果:', aiResult);
    if (aiResult === 'pass') status = 'approved';
    else if (aiResult === 'rejected') status = 'rejected';
  } catch (e) {
    console.error("[学生证] AI 鉴伪异常，转人工:", e.message);
  }
  // 2) 阿里云内容安全 /green/image/scan 仅支持「图片 URL」传图，不支持 base64（imageBytes 会报 400）。
  //    当前学生证为 base64 上传，故此处不调用阿里云，仅依赖百炼鉴伪；若需使用阿里云，需先将图片上传至 OSS 再传 URL。
  console.log('[学生证] 最终状态:', status);

  db.run(
    'INSERT INTO student_id_verifications (school_name, image_data, status, nickname) VALUES (?, ?, ?, ?)',
    [schoolName, rawBase64, status, nick],
    function (err) {
      if (err) {
        res.send({ code: 500, msg: "提交失败" });
        return;
      }
      const id = this.lastID;
      if (status === 'approved') {
        const authToken = require('crypto').randomBytes(32).toString('hex');
        const tokenExpiresAt = new Date(Date.now() + TOKEN_EXPIRY_MS).toISOString();
        db.run(
          'UPDATE student_id_verifications SET auth_token = ?, token_expires_at = ? WHERE id = ?',
          [authToken, toMySQLDateTime(tokenExpiresAt), id],
          (updateErr) => {
            if (updateErr) {
              res.send({ code: 200, submissionId: id, status: 'pending_manual', msg: "已提交，等待人工审核" });
              return;
            }
            db.run(
              'INSERT INTO verified_users (email, school_name, auth_type, auth_token, token_expires_at, nickname) VALUES (?, ?, ?, ?, ?, ?)',
              ['sid_' + id, schoolName, 'student_id', authToken, toMySQLDateTime(tokenExpiresAt), nick],
              () => {
                res.send({ code: 200, msg: "认证成功", authToken, school: schoolName, nickname: nick, submissionId: id });
              }
            );
          }
        );
      } else if (status === 'rejected') {
        res.send({ code: 200, submissionId: id, status: 'rejected', msg: "图片未通过鉴伪，请使用真实学生证照片" });
      } else {
        res.send({ code: 200, submissionId: id, status: 'pending_manual', msg: "已提交，等待人工审核" });
      }
    }
  );
});

/** 阿里云内容安全 API 的签名（POP 规范），用于调用图片检测 */
function signAliyunGreen(method, path, body, headers, accessKeySecret) {
  const crypto = require('crypto');
  const contentMd5 = body ? crypto.createHash('md5').update(body, 'utf8').digest('base64') : '';
  const stringToSign = [
    method,
    'application/json',
    contentMd5,
    'application/json',
    headers['Date'],
    Object.keys(headers)
      .filter((k) => k.toLowerCase().startsWith('x-acs-'))
      .sort()
      .map((k) => k + ':' + headers[k])
      .join('\n'),
    path
  ].join('\n');
  const signature = crypto.createHmac('sha1', accessKeySecret + '&').update(stringToSign, 'utf8').digest('base64');
  return signature;
}

async function callAliyunImageScan(imageBase64) {
  console.log('[阿里云] 开始调用内容安全图片鉴伪接口');
  const fetch = (await import('node-fetch')).default;
  const crypto = require('crypto');
  const endpoint = 'green.cn-shanghai.aliyuncs.com';
  const clientInfoStr = JSON.stringify({ userId: 'student_id_check' });
  const pathForSign = '/green/image/scan?clientInfo=' + clientInfoStr;
  const body = JSON.stringify({
    bizType: 'student_id_check',
    scenes: ['porn', 'terrorism'],
    tasks: [{ dataId: crypto.randomUUID(), imageBytes: imageBase64 }]
  });
  const date = new Date().toUTCString();
  const nonce = crypto.randomUUID();
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Date': date,
    'x-acs-version': '2018-05-09',
    'x-acs-signature-nonce': nonce,
    'x-acs-signature-version': '1.0',
    'x-acs-signature-method': 'HMAC-SHA1'
  };
  const contentMd5 = crypto.createHash('md5').update(body, 'utf8').digest('base64');
  headers['Content-MD5'] = contentMd5;
  const signature = signAliyunGreen('POST', pathForSign, body, headers, ALIYUN_ACCESS_KEY_SECRET);
  headers['Authorization'] = 'acs ' + ALIYUN_ACCESS_KEY_ID + ':' + signature;

  try {
    const url = 'https://' + endpoint + '/green/image/scan?clientInfo=' + encodeURIComponent(clientInfoStr);
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body
    });
    const result = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      console.warn('[阿里云] 图片审核 HTTP', resp.status, result.message || result.msg || JSON.stringify(result).slice(0, 200));
      throw new Error(result.message || result.msg || 'Request failed');
    }
    if (result.code === 200 && result.data && result.data.results && result.data.results[0]) {
      const suggestion = (result.data.results[0].suggestion || 'review').toLowerCase();
      console.log('[阿里云] 鉴伪接口调用完成，suggestion:', suggestion);
      if (suggestion === 'pass') return 'pass';
      if (suggestion === 'block') return 'rejected';
    }
    if (result.code === 400 && (result.message || '').toLowerCase().includes('url')) {
      console.warn('[阿里云] 图片审核仅支持 URL 传图，当前使用 base64 可能被拒，请配置 OSS 或使用人工审核');
    }
  } catch (e) {
    console.warn('[阿里云] 图片审核调用失败，转人工:', e.message);
    throw e;
  }
  return 'review';
}

// GET 学生证认证状态轮询：前端传 submissionId，人工通过后可拿到 authToken
app.get('/api/auth/student-id/status', (req, res) => {
  const submissionId = req.query.submissionId;
  if (!submissionId) {
    res.send({ code: 400, msg: "缺少 submissionId" });
    return;
  }
  db.get(
    'SELECT status, auth_token, token_expires_at, school_name, nickname FROM student_id_verifications WHERE id = ?',
    [submissionId],
    (err, row) => {
      if (err || !row) {
        res.send({ code: 404, msg: "记录不存在" });
        return;
      }
      const expired = row.token_expires_at && new Date(row.token_expires_at) < new Date();
      res.send({
        code: 200,
        status: row.status,
        authToken: row.status === 'approved' && !expired ? row.auth_token : undefined,
        school: row.school_name,
        nickname: row.nickname || undefined
      });
    }
  );
});

/** 根据 authToken 查 verified_users，未过期则返回 { email, school_name, auth_type, nickname }，否则 null */
function parseAuthToken(authToken) {
  return new Promise((resolve) => {
    const t = authToken != null ? String(authToken).trim() : '';
    if (!t) return resolve(null);
    db.get(
      'SELECT email, school_name, auth_type, nickname FROM verified_users WHERE auth_token = ? AND token_expires_at > NOW()',
      [t],
      (err, row) => resolve(err ? null : row)
    );
  });
}

/** 从请求里取 token：body.authToken 或 auth_token → query.authToken → header X-Auth-Token 或 Authorization */
function getTokenFromRequest(req) {
  const body = req.body || {};
  let token = (body.authToken != null ? String(body.authToken).trim() : '') || (body.auth_token != null ? String(body.auth_token).trim() : '');
  if (!token && req.query && req.query.authToken != null) token = String(req.query.authToken).trim();
  if (!token) {
    const raw = req.headers['x-auth-token'] || req.headers['authorization'];
    token = (raw && String(raw).trim()) || '';
    if (token && token.toLowerCase().startsWith('bearer ')) token = token.slice(7).trim();
  }
  return (token || '').trim();
}

// GET 当前登录用户信息（学校、昵称、认证类型），前端用来恢复“已认证”状态
app.get('/api/auth/me', async (req, res) => {
  const token = getTokenFromRequest(req);
  const verified = await parseAuthToken(token || null);
  if (!verified) {
    res.send({ code: 403, msg: "未登录或已过期" });
    return;
  }
  res.send({
    code: 200,
    school: verified.school_name,
    nickname: verified.nickname,
    authType: verified.auth_type
  });
});

// POST 提交学生分享：需认证；发帖前百炼审核内容，违规 block，存疑 pending_review；提交后异步 DeepSeek 分析有用度/情绪
app.post('/api/student-shares', async (req, res) => {
  const body = req.body || {};
  const { school, major, grade, title, content, tags, images, fromShareForm, nickname, author_nickname } = body;
  const token = getTokenFromRequest(req);

  if (!title || !content) {
    res.send({ code: 400, msg: "标题和内容为必填项" });
    return;
  }

  let verified = await parseAuthToken(token || null);
  let finalSchool = (school != null ? String(school).trim() : '') || '';
  let finalMajor = (major != null ? String(major) : '') || '';
  let authorNick = '在读生';

  if (verified) {
    authorNick = verified.nickname || '在读生';
    if (!finalSchool) {
      res.send({ code: 400, msg: "请确定认证学校（发帖必须为认证学校）" });
      return;
    }
    if (finalSchool !== verified.school_name) {
      res.send({ code: 403, msg: `您只能发布认证学校「${verified.school_name}」相关内容` });
      return;
    }
  } else {
    // token 无效：仅当来自「分享你的经历」表单且带学校时兜底允许发帖（该页仅在认证通过后展示）
    if (fromShareForm && finalSchool && title && content) {
      authorNick = (nickname != null ? String(nickname).trim() : '') || (author_nickname != null ? String(author_nickname).trim() : '') || '在读生';
    } else {
      res.send({ code: 403, msg: "请先完成信息认证" });
      return;
    }
  }

  // 分享的所有内容均发送给 AI 审核
  let postStatus = 'approved';
  try {
    const modResult = await callBailianTextModeration(title, content, tags || '');
    if (modResult === 'block') {
      res.send({ code: 400, msg: "内容涉嫌违规，无法发布" });
      return;
    }
    if (modResult === 'review') postStatus = 'pending_review';
  } catch (e) {
    console.error("发帖内容审核异常，转后台审核:", e.message);
    postStatus = 'pending_review';
  }

  const imagesStr = images && Array.isArray(images) ? images.join(IMAGE_SEP) : '';
  const sql = `INSERT INTO student_shares (school, major, grade, title, content, tags, images, status, author_nickname) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  db.run(sql, [finalSchool, finalMajor, grade || '', title, content, tags || '', imagesStr, postStatus, authorNick], function (err) {
    if (err) {
      console.error("保存学生分享失败:", err);
      res.send({ code: 500, msg: "保存失败" });
      return;
    }
    const shareId = this.lastID;
    db.run('UPDATE student_shares SET share_number = ? WHERE id = ?', [shareId, shareId], () => {});
    const msg = postStatus === 'pending_review' ? "分享已提交，待人工审核通过后展示" : "分享提交成功！";
    res.send({ code: 200, msg, id: shareId, share_number: shareId, status: postStatus });
    // 异步：DeepSeek 分析有用比率与情绪，并设置 delete_after
    analyzeShareAndUpdate(shareId, title, content, tags || '').catch(e => console.error('analyzeShareAndUpdate error:', e));
  });
});

// 举报帖子；同一帖子举报数达到 REPORT_THRESHOLD 后 status 改为 pending_review
const REPORT_THRESHOLD = 50;
app.post('/api/student-shares/:id/report', async (req, res) => {
  const shareId = req.params.id;
  const token = getTokenFromRequest(req);
  const verified = await parseAuthToken(token || null);
  const userEmail = verified ? verified.email : 'anonymous';
  db.run('INSERT INTO share_reports (share_id, user_email) VALUES (?, ?)', [shareId, userEmail], function (err) {
    if (err) {
      res.send({ code: 500, msg: "举报失败" });
      return;
    }
    db.get('SELECT COUNT(*) AS cnt FROM share_reports WHERE share_id = ?', [shareId], (e, row) => {
      if (!e && row && row.cnt >= REPORT_THRESHOLD) {
        db.run("UPDATE student_shares SET status = 'pending_review' WHERE id = ?", [shareId], () => {});
      }
      res.send({ code: 200, msg: "举报已提交" });
    });
  });
});

// 点赞时识别用户：认证用户用 token，游客用 guestId（body 或 query）
function getLikeUserIdentity(req) {
  const token = getTokenFromRequest(req);
  const body = req.body || {};
  const query = req.query || {};
  const guestId = (body.guestId != null ? body.guestId : query.guestId) != null ? String(body.guestId || query.guestId).trim() : '';
  return { token, guestId };
}
app.post('/api/student-shares/:id/like', async (req, res) => {
  const shareId = parseInt(String(req.params.id), 10);
  if (Number.isNaN(shareId) || shareId < 1) {
    res.send({ code: 400, msg: "参数错误" });
    return;
  }
  const { token, guestId } = getLikeUserIdentity(req);
  const verified = await parseAuthToken(token || null);
  let userEmail = verified ? verified.email : (guestId ? 'guest_' + guestId : null);
  if (!userEmail && token) {
    const crypto = require('crypto');
    userEmail = 'token_' + crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 32);
  }
  if (!userEmail) userEmail = 'guest_temp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
  db.get('SELECT id FROM student_shares WHERE id = ? AND status = ?', [shareId, 'approved'], (err, row) => {
    if (err || !row) {
      res.send({ code: 404, msg: "帖子不存在或已删除" });
      return;
    }
    db.get('SELECT 1 FROM share_likes WHERE share_id = ? AND user_email = ?', [shareId, userEmail], (e, likeRow) => {
      if (likeRow) {
        db.run('DELETE FROM share_likes WHERE share_id = ? AND user_email = ?', [shareId, userEmail], function (delErr) {
          if (delErr) {
            res.send({ code: 500, msg: "操作失败" });
            return;
          }
          db.get('SELECT COUNT(*) AS cnt FROM share_likes WHERE share_id = ?', [shareId], (_, c) => {
            res.send({ code: 200, liked: false, like_count: (c && c.cnt) || 0 });
          });
        });
      } else {
        db.run('INSERT INTO share_likes (share_id, user_email) VALUES (?, ?)', [shareId, userEmail], function (insErr) {
          if (insErr) {
            res.send({ code: 500, msg: "操作失败" });
            return;
          }
          db.get('SELECT COUNT(*) AS cnt FROM share_likes WHERE share_id = ?', [shareId], (_, c) => {
            res.send({ code: 200, liked: true, like_count: (c && c.cnt) || 0 });
          });
        });
      }
    });
  });
});

// GET 某帖子的评论列表（一级+回复，仅已通过；有 token/guestId 时带 user_has_liked）
app.get('/api/student-shares/:id/comments', async (req, res) => {
  const shareId = parseInt(String(req.params.id), 10);
  if (Number.isNaN(shareId) || shareId < 1) {
    res.send({ code: 400, msg: "参数错误" });
    return;
  }
  const token = getTokenFromRequest(req);
  const verified = await parseAuthToken(token || null);
  const guestId = (req.query && req.query.guestId != null) ? String(req.query.guestId).trim() : '';
  let userEmail = verified ? verified.email : (guestId ? 'guest_' + guestId : null);
  if (!userEmail && token) userEmail = 'token_' + require('crypto').createHash('sha256').update(String(token)).digest('hex').slice(0, 32);
  db.run(`UPDATE share_comments SET status = 'deleted' WHERE delete_after IS NOT NULL AND delete_after <= NOW()`, () => {});

  function sendCommentRows(rows) {
    if (!rows || rows.length === 0) return res.send({ code: 200, data: [] });
    const commentIds = rows.map((r) => r.id);
    let userLikedIds = [];
    if (userEmail) {
      const placeholders = commentIds.map(() => '?').join(',');
      db.all(`SELECT comment_id FROM comment_likes WHERE comment_id IN (${placeholders}) AND user_email = ?`, [...commentIds, userEmail], (e, r) => {
        if (!e && r) userLikedIds = (r || []).map((x) => x.comment_id);
        rows.forEach((row) => { row.user_has_liked = userLikedIds.indexOf(row.id) !== -1; });
        res.send({ code: 200, data: rows });
      });
    } else {
      rows.forEach((row) => { row.user_has_liked = false; });
      res.send({ code: 200, data: rows });
    }
  }

  const fullSql = `SELECT id, share_id, parent_id, user_email, school_name, nickname, content, status, like_count, created_at FROM share_comments WHERE share_id = ? AND status = 'approved'
     AND (is_emotional IS NULL OR is_emotional = 0)
     AND (delete_after IS NULL OR delete_after > NOW())
     ORDER BY created_at ASC`;
  const simpleSql = `SELECT id, share_id, parent_id, user_email, school_name, nickname, content, status, like_count, created_at FROM share_comments WHERE share_id = ? AND status = 'approved' ORDER BY created_at ASC`;

  db.all(fullSql, [shareId], (err, rows) => {
    if (err) {
      const msg = (err.message || '').toLowerCase();
      if (msg.includes('no such column') || msg.includes('is_emotional') || msg.includes('delete_after')) {
        db.all(simpleSql, [shareId], (err2, rows2) => {
          if (err2) {
            console.error('获取评论失败:', err2.message);
            return res.send({ code: 500, msg: "获取评论失败" });
          }
          sendCommentRows(rows2);
        });
        return;
      }
      console.error('获取评论失败:', err.message);
      return res.send({ code: 500, msg: "获取评论失败" });
    }
    sendCommentRows(rows);
  });
});

// POST 发表评论/回复：identity=guest 为游客，identity=verified 用昵称+学校；所有评论经百炼审核
app.post('/api/student-shares/:id/comments', async (req, res) => {
  const shareId = parseInt(String(req.params.id), 10);
  if (Number.isNaN(shareId) || shareId < 1) {
    res.send({ code: 400, msg: "参数错误" });
    return;
  }
  const body = req.body || {};
  const { content, parent_id: parentId, identity, nickname: bodyNickname, school_name: bodySchool, guestId: bodyGuestId } = body;
  const contentTrim = (content != null ? String(content).trim() : '') || '';
  if (!contentTrim) {
    res.send({ code: 400, msg: "评论内容不能为空" });
    return;
  }
  // 直接采用前端传来的身份：identity=guest 为游客（存 guest_xxx 便于本人删评），identity=verified 为昵称+认证学校
  const isVerified = identity === 'verified';
  const schoolName = isVerified ? (String(bodySchool != null ? bodySchool : '').trim() || '') : '游客';
  const nickname = isVerified ? (String(bodyNickname != null ? bodyNickname : '').trim() || '在读生') : '游客';
  const userEmail = isVerified ? (nickname + '_' + schoolName || 'verified') : ('guest_' + (String(bodyGuestId != null ? bodyGuestId : '').trim() || 'anonymous'));
  db.get('SELECT id FROM student_shares WHERE id = ? AND status = ?', [shareId, 'approved'], (err, shareRow) => {
    if (err || !shareRow) {
      res.send({ code: 404, msg: "帖子不存在或已删除" });
      return;
    }
    const finalParentId = parentId != null ? parseInt(String(parentId), 10) : null;
    function checkParentThenSubmit() {
      if (finalParentId != null && !Number.isNaN(finalParentId)) {
        db.get('SELECT id FROM share_comments WHERE id = ? AND share_id = ?', [finalParentId, shareId], (e, pr) => {
          if (e || !pr) {
            res.send({ code: 400, msg: "回复的评论不存在" });
            return;
          }
          submitCommentAfterModeration();
        });
      } else {
        submitCommentAfterModeration();
      }
    }
    // 所有评论（无论身份）均经 AI 审核，通过后可发布
    async function submitCommentAfterModeration() {
      let commentStatus = 'approved';
      try {
        const modResult = await callBailianTextModeration('', contentTrim, '');
        if (modResult === 'block') {
          res.send({ code: 400, msg: "内容涉嫌违规，无法发布" });
          return;
        }
        if (modResult === 'review') commentStatus = 'pending_review';
      } catch (e) {
        console.error("评论内容审核异常，转待审:", e.message);
        commentStatus = 'pending_review';
      }
      db.run(
        'INSERT INTO share_comments (share_id, parent_id, user_email, school_name, nickname, content, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [shareId, (finalParentId != null && !Number.isNaN(finalParentId)) ? finalParentId : null, userEmail, schoolName, nickname, contentTrim, commentStatus],
        function (insErr) {
          if (insErr) {
            res.send({ code: 500, msg: "发表失败" });
            return;
          }
          const commentId = this.lastID;
          const msg = commentStatus === 'pending_review' ? "评论已提交，待审核通过后展示" : "评论成功";
          res.send({ code: 200, msg, id: commentId, status: commentStatus });
          analyzeCommentAndUpdate(commentId, contentTrim).catch(e => console.error('analyzeCommentAndUpdate error:', e));
        }
      );
    }
    checkParentThenSubmit();
  });
});

// 举报评论（同帖子举报逻辑，≥50 进待审）
app.post('/api/student-shares/:shareId/comments/:commentId/report', async (req, res) => {
  const commentId = parseInt(String(req.params.commentId), 10);
  if (Number.isNaN(commentId) || commentId < 1) {
    res.send({ code: 400, msg: "参数错误" });
    return;
  }
  const token = getTokenFromRequest(req);
  const verified = await parseAuthToken(token || null);
  const userEmail = verified ? verified.email : 'anonymous';
  db.run('INSERT INTO comment_reports (comment_id, user_email) VALUES (?, ?)', [commentId, userEmail], function (err) {
    if (err) {
      res.send({ code: 500, msg: "举报失败" });
      return;
    }
    db.get('SELECT COUNT(*) AS cnt FROM comment_reports WHERE comment_id = ?', [commentId], (e, row) => {
      if (!e && row && row.cnt >= REPORT_THRESHOLD) {
        db.run("UPDATE share_comments SET status = 'pending_review' WHERE id = ?", [commentId], () => {});
      }
      res.send({ code: 200, msg: "举报已提交" });
    });
  });
});

// 评论点赞/取消点赞（身份同帖子点赞）
app.post('/api/student-shares/:shareId/comments/:commentId/like', async (req, res) => {
  const commentId = parseInt(String(req.params.commentId), 10);
  if (Number.isNaN(commentId) || commentId < 1) {
    res.send({ code: 400, msg: "参数错误" });
    return;
  }
  const { token, guestId } = getLikeUserIdentity(req);
  const verified = await parseAuthToken(token || null);
  let userEmail = verified ? verified.email : (guestId ? 'guest_' + guestId : null);
  if (!userEmail && token) {
    const crypto = require('crypto');
    userEmail = 'token_' + crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 32);
  }
  if (!userEmail) userEmail = 'guest_temp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
  db.get('SELECT id, like_count FROM share_comments WHERE id = ? AND status = ?', [commentId, 'approved'], (err, row) => {
    if (err || !row) {
      res.send({ code: 404, msg: "评论不存在或已删除" });
      return;
    }
    db.get('SELECT 1 FROM comment_likes WHERE comment_id = ? AND user_email = ?', [commentId, userEmail], (e, likeRow) => {
      if (likeRow) {
        db.run('DELETE FROM comment_likes WHERE comment_id = ? AND user_email = ?', [commentId, userEmail], function (delErr) {
          if (delErr) {
            res.send({ code: 500, msg: "操作失败" });
            return;
          }
          db.run('UPDATE share_comments SET like_count = CASE WHEN like_count > 0 THEN like_count - 1 ELSE 0 END WHERE id = ?', [commentId], () => {});
          db.get('SELECT like_count FROM share_comments WHERE id = ?', [commentId], (_, c) => {
            res.send({ code: 200, liked: false, like_count: (c && c.like_count) || 0 });
          });
        });
      } else {
        db.run('INSERT INTO comment_likes (comment_id, user_email) VALUES (?, ?)', [commentId, userEmail], function (insErr) {
          if (insErr) {
            res.send({ code: 500, msg: "操作失败" });
            return;
          }
          db.run('UPDATE share_comments SET like_count = like_count + 1 WHERE id = ?', [commentId], () => {});
          db.get('SELECT like_count FROM share_comments WHERE id = ?', [commentId], (_, c) => {
            res.send({ code: 200, liked: true, like_count: (c && c.like_count) || 0 });
          });
        });
      }
    });
  });
});

// ========== 学校 API ==========
// 学校列表：schools 表 + school_programs 里出现过的学校（去重）；外层聚合满足 MySQL ONLY_FULL_GROUP_BY
app.get('/api/schools', (req, res) => {
  const sql = `SELECT school_name, ANY_VALUE(school_level) AS school_level, ANY_VALUE(location) AS location
               FROM (
                 SELECT school_name, school_level, location FROM schools
                 UNION
                 SELECT school_name, school_level, location FROM school_programs WHERE school_name NOT IN (SELECT school_name FROM schools)
               ) AS u
               GROUP BY school_name
               ORDER BY school_name`;
  db.all(sql, [], (err, rows) => {
    if (err) {
      console.error("获取学校列表失败:", err);
      res.send({ code: 500, msg: "获取失败" });
      return;
    }
    res.send({ code: 200, data: rows });
  });
});

// 某学校下的所有专业（school_programs + major_overviews 联表）
app.get('/api/schools/:schoolName/majors', (req, res) => {
  const schoolName = req.params.schoolName;
  const sql = `SELECT sp.id, sp.major_id, sp.school_name, sp.school_level, sp.location, sp.program_features, sp.courses, sp.admission_requirements, sp.tuition_fee, sp.scholarships, sp.contact_info, mo.major_name, mo.category, mo.degree_type 
               FROM school_programs sp 
               LEFT JOIN major_overviews mo ON sp.major_id = mo.id 
               WHERE sp.school_name = ? ORDER BY mo.major_name`;
  db.all(sql, [schoolName], (err, rows) => {
    if (err) {
      console.error("获取学校专业失败:", err);
      res.send({ code: 500, msg: "获取失败" });
      return;
    }
    res.send({ code: 200, data: rows });
  });
});

// 管理员：添加学校
app.post('/api/admin/schools', verifyAdmin, (req, res) => {
  const { password, school_name, school_level, location, description } = req.body;
  
  const sql = `INSERT INTO schools (school_name, school_level, location, description) VALUES (?, ?, ?, ?)`;
  db.run(sql, [school_name, school_level, location, description], function(err) {
    if (err) {
      console.error("添加学校失败:", err);
      res.send({ code: 500, msg: "添加失败: " + err.message });
      return;
    }
    res.send({ code: 200, msg: "添加成功", id: this.lastID });
  });
});

// 管理员：添加学校专业项目
app.post('/api/admin/school-programs', verifyAdmin, (req, res) => {
  const { password, school_name, major_id, major_name, program_features, courses, stream_division, admission_requirements, tuition_fee, scholarships, contact_info } = req.body;
  
  if (!school_name || !major_id) {
    res.send({ code: 400, msg: "学校名称和专业ID为必填项" });
    return;
  }
  
  const sql = `INSERT INTO school_major_programs (school_name, major_id, major_name, program_features, courses, stream_division, admission_requirements, tuition_fee, scholarships, contact_info) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  db.run(sql, [school_name, major_id, major_name, program_features, courses, stream_division, admission_requirements, tuition_fee, scholarships, contact_info], function(err) {
    if (err) {
      console.error("添加学校专业项目失败:", err);
      res.send({ code: 500, msg: "添加失败: " + err.message });
      return;
    }
    res.send({ code: 200, msg: "添加成功", id: this.lastID });
  });
});

// ========== 数据录入与内容分析用 AI（DeepSeek） ==========
/** 调用 DeepSeek 对话接口；429 时自动重试 2 次 */
async function callDeepSeekAI(prompt, systemPrompt = '', retryCount = 0) {
  const fetch = (await import('node-fetch')).default;
  if (!DEEPSEEK_API_KEY) {
    throw new Error("DeepSeek 密钥未配置（请设置 DEEPSEEK_API_KEY）");
  }
  const body = {
    model: DEEPSEEK_MODEL,
    messages: [
      {
        role: 'system',
        content: systemPrompt || '你是一个专业的教育数据管理助手，擅长整理和分析高校及专业信息。请根据用户提供的院校或专业名称，从官方网站检索相关信息并以结构化JSON格式返回。'
      },
      { role: 'user', content: prompt }
    ],
    temperature: 0.7,
    max_tokens: 4000
  };
  const response = await fetch(DEEPSEEK_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
    },
    body: JSON.stringify(body)
  });
  if (response.status === 429 && retryCount < 2) {
    const waitMs = 5000 + retryCount * 3000;
    console.warn(`DeepSeek API 429，${waitMs / 1000}秒后重试 (${retryCount + 1}/2)`);
    await new Promise((r) => setTimeout(r, waitMs));
    return callDeepSeekAI(prompt, systemPrompt, retryCount + 1);
  }
  if (!response.ok) {
    const errorText = await response.text();
    console.error(`DeepSeek API 错误: ${response.status}`, errorText.slice(0, 300));
    if (response.status === 429) throw new Error("DeepSeek 请求过于频繁(429)，请稍后再试");
    throw new Error(`DeepSeek API 错误: ${response.status}`);
  }
  const result = await response.json();
  return result.choices?.[0]?.message?.content || '';
}

/** 统计文本中各个“类型词”的出现次数，并根据占比生成自动标签 */
function analyzeCategoryDistribution(text, keywordCategoriesMap) {
  const result = [];
  const plain = (text || '').toString();
  if (!plain.trim()) return { total: 0, stats: [], autoTags: [] };

  let totalCount = 0;
  for (const [category, keywords] of Object.entries(keywordCategoriesMap || {})) {
    let count = 0;
    for (const kw of keywords) {
      if (!kw) continue;
      const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(escaped, 'g');
      const matches = plain.match(re);
      if (matches) count += matches.length;
    }
    if (count > 0) {
      result.push({ category, count });
      totalCount += count;
    }
  }

  if (!totalCount) return { total: 0, stats: [], autoTags: [] };

  result.sort((a, b) => b.count - a.count);
  const autoTags = [];
  result.forEach((item, index) => {
    const ratio = item.count / totalCount;
    if (ratio >= 0.2 || (index === 0 && ratio >= 0.15) || index < 2) {
      autoTags.push(item.category);
    }
  });
  return { total: totalCount, stats: result, autoTags };
}

/** 学生分享发布后异步调用：DeepSeek 分析有用度 usefulness_ratio 和是否情绪过重，写回 DB；若无用或情绪化则设 delete_after 为 24h 后；同时根据 MySQL 中的类型词占比自动打标签（可在前端继续编辑） */
async function analyzeShareAndUpdate(shareId, title, content, tags) {
  if (!DEEPSEEK_API_KEY) return;
  const text = [title, content, tags].filter(Boolean).join('\n');

  // 从 MySQL 中读取「类型词」与分类，用于提示 AI 判断有用度，同时本地计算各分类占比
  const keywordCategoriesMap = await loadKeywordCategories();
  const keywordCategoryDesc = Object.entries(keywordCategoriesMap || {})
    .map(([cat, kws]) => `${cat}：${kws.join('、')}`)
    .join('；');

  const systemPrompt = `你是一个面向高考生的校园内容质量评估助手。请仅根据用户给出一段帖子文本，完成两项判断，并只输出一个 JSON 对象，不要其他说明或换行外的内容。

1) 有用比率 usefulness_ratio（0-100 的整数）：以句子为单位，根据以下「内容比率关键词」是否出现及出现频率，判断该帖对高考生了解校园生活或学习情况是否有用。不同类型及其关键词如下（每类里的词语在数据库中维护，这里只是当前快照）：
${keywordCategoryDesc}
综合整篇帖子，给出 0-100 的有用比率。

2) 情绪过重 is_emotional（0 或 1）：若帖子或评论存在明显情绪过重倾向，如咒骂学校/专业、极度消极、中重度抑郁倾向等，则 is_emotional 为 1，否则为 0。

只输出如下格式的 JSON，不要 markdown 代码块包裹以外的内容：
{"usefulness_ratio": 数字, "is_emotional": 0或1}`;

  const prompt = `请分析以下帖子并只返回上述 JSON：\n\n${text.slice(0, 6000)}`;
  let raw;
  try {
    raw = await callDeepSeekAI(prompt, systemPrompt);
  } catch (e) {
    console.error('DeepSeek 分析帖子失败:', e.message);
    return;
  }
  let usefulness_ratio = null;
  let is_emotional = 0;
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]);
      const u = Number(obj.usefulness_ratio);
      if (!Number.isNaN(u) && u >= 0 && u <= 100) usefulness_ratio = u;
      if (obj.is_emotional === 1 || obj.is_emotional === true) is_emotional = 1;
    } catch (_) {}
  }
  const shouldDelete = (usefulness_ratio != null && usefulness_ratio < 40) || is_emotional === 1;

  // 基于 MySQL 中的类型词，对帖子进行本地分类占比分析并自动打标签（只作为初始标签，发帖人后续仍可在前端编辑）
  const { autoTags } = analyzeCategoryDistribution(text, keywordCategoriesMap);
  db.get(
    'SELECT tags FROM student_shares WHERE id = ?',
    [shareId],
    (selectErr, row) => {
      if (selectErr) {
        console.error('SELECT student_shares.tags 失败:', selectErr);
      }
      const existingTagsStr = row && row.tags ? String(row.tags) : '';
      const existingTags = existingTagsStr
        .split(/[,，、\s]+/)
        .map((t) => t.trim())
        .filter(Boolean);
      const merged = Array.from(new Set([...existingTags, ...autoTags]));
      const finalTagsStr = merged.join('、');

      db.run(
        `UPDATE student_shares SET usefulness_ratio = ?, is_emotional = ?, analyzed_at = NOW(), delete_after = ${
          shouldDelete ? "DATE_ADD(NOW(), INTERVAL 24 HOUR)" : 'NULL'
        }, tags = ? WHERE id = ?`,
        [usefulness_ratio, is_emotional, finalTagsStr, shareId],
        (err) => {
          if (err) console.error('UPDATE student_shares 分析结果失败:', err);
        }
      );
    }
  );
}

/** 评论发布后异步：DeepSeek 判断是否情绪过重，写回 is_emotional，过重则设 delete_after */
async function analyzeCommentAndUpdate(commentId, content) {
  if (!DEEPSEEK_API_KEY) return;
  const systemPrompt = `你是一个内容安全评估助手。只根据用户给出一段评论文本，判断是否「情绪过重」：如咒骂学校/专业、极度消极、中重度抑郁倾向等。只输出一个 JSON：{"is_emotional": 0 或 1}，不要其他内容。`;
  const prompt = `评论内容：\n${content.slice(0, 3000)}\n\n请只返回上述 JSON。`;
  let raw;
  try {
    raw = await callDeepSeekAI(prompt, systemPrompt);
  } catch (e) {
    console.error('DeepSeek 分析评论失败:', e.message);
    return;
  }
  let is_emotional = 0;
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]);
      if (obj.is_emotional === 1 || obj.is_emotional === true) is_emotional = 1;
    } catch (_) {}
  }
  const shouldDelete = is_emotional === 1;
  db.run(
    `UPDATE share_comments SET is_emotional = ?, analyzed_at = NOW(), delete_after = ${shouldDelete ? "DATE_ADD(NOW(), INTERVAL 24 HOUR)" : 'NULL'} WHERE id = ?`,
    [is_emotional, commentId],
    (err) => { if (err) console.error('UPDATE share_comments 分析结果失败:', err); }
  );
}

/** 数据录入统一走 DeepSeek；未配置会抛错 */
async function callDataEntryAI(prompt, systemPrompt = '') {
  if (!DEEPSEEK_API_KEY)
    throw new Error("DeepSeek 未配置，请设置 DEEPSEEK_API_KEY 后进行数据录入");
  return callDeepSeekAI(prompt, systemPrompt);
}

/** 查 school_programs 表，该专业+该学校是否已有记录 */
function schoolProgramExists(majorId, schoolName) {
  return new Promise((resolve) => {
    db.get('SELECT id FROM school_programs WHERE major_id = ? AND school_name = ?', [majorId, schoolName], (err, row) => resolve(!!(row && !err)));
  });
}

/** 用 AI 根据学校官网判断是否开设某专业；未检索到则返回 false */
async function confirmSchoolOffersMajor(schoolName, majorName) {
  const prompt = `请仅根据「${schoolName}」官方网站（院校官网）的实际信息，判断该校是否开设「${majorName}」本科专业。只返回一个 JSON：若官网明确有该专业招生或培养信息则 {"offers": true}，若未检索到或无法确认则 {"offers": false}。不得猜测，未查到则必须返回 offers: false。`;
  const raw = await callDataEntryAI(prompt);
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const obj = JSON.parse(m[0]);
      if (obj.offers === false) return false;
    } catch (_) {}
  }
  return true;
}

/** 根据专业名+学校名：若专业已存在则只查该校该专业开设信息；否则从阳光高考+官网查全量并建 major_overviews + 返回 program 数据 */
async function getOrCreateMajorAndProgramData(majorName, schoolName) {
  const offers = await confirmSchoolOffersMajor(schoolName, majorName);
  if (!offers) throw new Error('未检索到该校开设该专业，不录入');

  const existing = await new Promise((resolve) => {
    db.get('SELECT id FROM major_overviews WHERE major_name = ?', [majorName], (err, row) => resolve(err ? null : row));
  });
  const officialSource = `所有开设院校信息、培养计划、课程等必须仅来自「${schoolName}」官方网站，不得编造或使用非官网来源。`;
  if (existing) {
    const prompt = `请从「${schoolName}」官方网站（院校官网）检索「${majorName}」专业在该校的开设信息。${officialSource}
以JSON格式返回：
{"school_level":"院校层次","location":"所在城市","program_features":"培养特色（200字以内）","courses":"主要课程，逗号分隔","course_intros":[{"name":"课程名","intro":"课程基本介绍（50-100字）"}，可多项，无介绍则intro为空字符串],"admission_requirements":"招生要求","tuition_fee":"学费","scholarships":"奖学金","contact_info":"招生办联系方式"}`;
    const aiResponse = await callDataEntryAI(prompt);
    const m = aiResponse.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('AI返回解析失败');
    const raw = JSON.parse(m[0]);
    const programData = {
      school_level: raw.school_level || '',
      location: raw.location || '',
      program_features: raw.program_features || '',
      courses: raw.courses || '',
      course_intros: Array.isArray(raw.course_intros) ? JSON.stringify(raw.course_intros) : '',
      admission_requirements: raw.admission_requirements || '',
      tuition_fee: raw.tuition_fee || '',
      scholarships: raw.scholarships || '',
      contact_info: raw.contact_info || ''
    };
    return { majorId: existing.id, programData };
  }
  const fullPrompt = `请按以下两个数据源分别检索并合并为一条JSON（用于系统录入，缺项填空字符串）：
1）专业概况（介绍、培养方案、修读课程、招生计划、学科门类、学位、学制、就业、相关专业）请前往阳光高考平台（gaokao.chsi.com.cn）查询「${majorName}」专业。
2）该校该专业的开设情况必须仅从「${schoolName}」官方网站（院校官网）查询。${officialSource}
严格按以下JSON格式返回：
{
  "description": "专业介绍（300字以内）",
  "training_plan": "培养方案要点（300字以内）",
  "core_courses": "修读课程，逗号分隔",
  "admission_plan": "招生计划（200字以内）",
  "category": "所属学科门类",
  "degree_type": "学位类型",
  "duration": "学制",
  "career_prospects": "就业前景简述",
  "related_majors": "相关专业，逗号分隔",
  "school_level": "院校层次",
  "location": "院校所在城市",
  "program_features": "该校该专业培养特色（200字以内）",
  "courses": "该校开设的主要课程，逗号分隔",
  "course_intros": [{"name":"课程名","intro":"课程基本介绍（50-100字）"}，可多项，无介绍则intro为空字符串],
  "admission_requirements": "招生要求",
  "tuition_fee": "学费",
  "scholarships": "奖学金",
  "contact_info": "招生办联系方式"
}`;
  const aiResponse = await callDataEntryAI(fullPrompt);
  const m = aiResponse.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('AI返回解析失败');
  const data = JSON.parse(m[0]);
  const majorId = await new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO major_overviews (major_name, category, degree_type, duration, description, core_courses, career_prospects, related_majors, training_plan, admission_plan) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        majorName,
        data.category || '',
        data.degree_type || '',
        data.duration || '',
        data.description || '',
        data.core_courses || '',
        data.career_prospects || '',
        data.related_majors || '',
        data.training_plan || '',
        data.admission_plan || ''
      ],
      function (err) {
        if (err) reject(err);
        else resolve(this.lastID);
      }
    );
  });
  const programData = {
    school_level: data.school_level || '',
    location: data.location || '',
    program_features: data.program_features || '',
    courses: data.courses || '',
    course_intros: Array.isArray(data.course_intros) ? JSON.stringify(data.course_intros) : '',
    admission_requirements: data.admission_requirements || '',
    tuition_fee: data.tuition_fee || '',
    scholarships: data.scholarships || '',
    contact_info: data.contact_info || ''
  };
  return { majorId, programData };
}

// 管理员：输入学校+专业名，AI 检索并写入（专业不存在会先创建；已录入则跳过）
app.post('/api/admin/ai-add-program', verifyAdmin, async (req, res) => {
  const { password, school_name, major_name } = req.body;
  
  if (!school_name || !major_name) {
    res.send({ code: 400, msg: "学校名称和专业名称为必填项" });
    return;
  }
  
  const sName = school_name.trim();
  const mName = major_name.trim();
  try {
    const { majorId, programData } = await getOrCreateMajorAndProgramData(mName, sName);
    const exists = await schoolProgramExists(majorId, sName);
    if (exists) {
      res.send({ code: 200, msg: "该专业下该院校已录入，已跳过", skipped: true, id: majorId, data: programData });
      return;
    }
    await new Promise((resolve, reject) => {
      const sql = `INSERT INTO school_programs (major_id, school_name, school_level, location, program_features, courses, course_intros, admission_requirements, tuition_fee, scholarships, contact_info) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
      db.run(sql, [
        majorId,
        sName,
        programData.school_level || '',
        programData.location || '',
        programData.program_features || '',
        programData.courses || '',
        programData.course_intros || '',
        programData.admission_requirements || '',
        programData.tuition_fee || '',
        programData.scholarships || '',
        programData.contact_info || ''
      ], function (insertErr) {
        if (insertErr) reject(insertErr);
        else resolve(this.lastID);
      });
    });
    db.run(`INSERT IGNORE INTO schools (school_name, school_level, location) VALUES (?, ?, ?)`, [sName, programData.school_level || '', programData.location || '']);
    res.send({ code: 200, msg: "AI检索并添加成功", id: majorId, data: programData });
  } catch (e) {
    console.error("AI添加失败:", e);
    const hint = !DEEPSEEK_API_KEY ? ' 请在后端服务器（如 115.29.233.160）环境变量中配置 DEEPSEEK_API_KEY。' : '';
    res.send({ code: 500, msg: "AI检索失败: " + e.message + hint });
  }
});
app.post('/admin/ai-add-program', verifyAdmin, async function aiAddProgramHandler (req, res) {
  const { password, school_name, major_name } = req.body;
  if (!school_name || !major_name) {
    res.send({ code: 400, msg: "学校名称和专业名称为必填项" });
    return;
  }
  const sName = school_name.trim();
  const mName = major_name.trim();
  try {
    const { majorId, programData } = await getOrCreateMajorAndProgramData(mName, sName);
    const exists = await schoolProgramExists(majorId, sName);
    if (exists) {
      res.send({ code: 200, msg: "该专业下该院校已录入，已跳过", skipped: true, id: majorId, data: programData });
      return;
    }
    await new Promise((resolve, reject) => {
      const sql = `INSERT INTO school_programs (major_id, school_name, school_level, location, program_features, courses, course_intros, admission_requirements, tuition_fee, scholarships, contact_info) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
      db.run(sql, [majorId, sName, programData.school_level || '', programData.location || '', programData.program_features || '', programData.courses || '', programData.course_intros || '', programData.admission_requirements || '', programData.tuition_fee || '', programData.scholarships || '', programData.contact_info || ''], function (insertErr) {
        if (insertErr) reject(insertErr);
        else resolve(this.lastID);
      });
    });
    db.run(`INSERT IGNORE INTO schools (school_name, school_level, location) VALUES (?, ?, ?)`, [sName, programData.school_level || '', programData.location || '']);
    res.send({ code: 200, msg: "AI检索并添加成功", id: majorId, data: programData });
  } catch (e) {
    console.error("AI添加失败:", e);
    const hint = !DEEPSEEK_API_KEY ? ' 请在后端服务器（如 115.29.233.160）环境变量中配置 DEEPSEEK_API_KEY。' : '';
    res.send({ code: 500, msg: "AI检索失败: " + e.message + hint });
  }
});

// 管理员：批量按学校+专业列表 AI 添加（每个专业不存在会自动创建）
app.post('/api/admin/ai-batch-add', verifyAdmin, async (req, res) => {
  const { password, school_name, majors } = req.body;
  
  if (!school_name || !majors || !Array.isArray(majors)) {
    res.send({ code: 400, msg: "参数错误" });
    return;
  }
  
  const results = [];
  const errors = [];
  const name = school_name.trim();

  for (const major of majors) {
    const majorStr = String(major).trim();
    if (!majorStr) continue;
    try {
      const { majorId, programData } = await getOrCreateMajorAndProgramData(majorStr, name);
      if (await schoolProgramExists(majorId, name)) {
        results.push({ major: majorStr, status: 'skipped', msg: '该院校该专业已录入' });
        continue;
      }
      await new Promise((resolve, reject) => {
        const sql = `INSERT INTO school_programs (major_id, school_name, school_level, location, program_features, courses, course_intros, admission_requirements, tuition_fee, scholarships, contact_info) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        db.run(sql, [
          majorId,
          name,
          programData.school_level || '',
          programData.location || '',
          programData.program_features || '',
          programData.courses || '',
          programData.course_intros || '',
          programData.admission_requirements || '',
          programData.tuition_fee || '',
          programData.scholarships || '',
          programData.contact_info || ''
        ], function (err) {
          if (err) reject(err);
          else resolve(this.lastID);
        });
      });
      db.run(`INSERT IGNORE INTO schools (school_name, school_level, location) VALUES (?, ?, ?)`, [name, programData.school_level || '', programData.location || '']);
      results.push({ major: majorStr, status: 'success' });
    } catch (err) {
      errors.push({ major: majorStr, error: err.message });
    }
  }
  
  res.send({
    code: 200,
    msg: `批量添加完成，成功${results.length}个，失败${errors.length}个`,
    results,
    errors
  });
});
app.post('/admin/ai-batch-add', verifyAdmin, async (req, res) => {
  const { password, school_name, majors } = req.body;
  if (!school_name || !majors || !Array.isArray(majors)) {
    res.send({ code: 400, msg: "参数错误" });
    return;
  }
  const results = [];
  const errors = [];
  const name = school_name.trim();
  for (const major of majors) {
    const majorStr = String(major).trim();
    if (!majorStr) continue;
    try {
      const { majorId, programData } = await getOrCreateMajorAndProgramData(majorStr, name);
      if (await schoolProgramExists(majorId, name)) {
        results.push({ major: majorStr, status: 'skipped', msg: '该院校该专业已录入' });
        continue;
      }
      await new Promise((resolve, reject) => {
        const sql = `INSERT INTO school_programs (major_id, school_name, school_level, location, program_features, courses, course_intros, admission_requirements, tuition_fee, scholarships, contact_info) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        db.run(sql, [majorId, name, programData.school_level || '', programData.location || '', programData.program_features || '', programData.courses || '', programData.course_intros || '', programData.admission_requirements || '', programData.tuition_fee || '', programData.scholarships || '', programData.contact_info || ''], function (err) {
          if (err) reject(err);
          else resolve(this.lastID);
        });
      });
      db.run(`INSERT IGNORE INTO schools (school_name, school_level, location) VALUES (?, ?, ?)`, [name, programData.school_level || '', programData.location || '']);
      results.push({ major: majorStr, status: 'success' });
    } catch (err) {
      errors.push({ major: majorStr, error: err.message });
    }
  }
  res.send({ code: 200, msg: `批量添加完成，成功${results.length}个，失败${errors.length}个`, results, errors });
});

// 管理员：只填学校名，AI 拉取该校本科招生专业列表并逐个录入（专业自动创建）
// 同时挂载 /admin/... 与 /api/admin/...，以兼容 Vercel 代理到后端时的路径
const handleAiAddSchoolAllMajors = async (req, res) => {
  const { password, school_name } = req.body;
  if (!school_name || !school_name.trim()) {
    res.send({ code: 400, msg: "请填写学校名称" });
    return;
  }
  const name = school_name.trim();
  const results = [];
  const errors = [];
  try {
    const listPrompt = `请列出「${name}」的本科招生专业列表。只返回一个 JSON 数组，格式为 ["专业名称1", "专业名称2", ...]，不要其他说明。`;
    const listResponse = await callDataEntryAI(listPrompt, '你只输出一个 JSON 数组，不要 markdown 代码块包裹。');
    let majorNames = [];
    const arrMatch = listResponse.match(/\[[\s\S]*\]/);
    if (arrMatch) {
      try {
        majorNames = JSON.parse(arrMatch[0]);
        if (!Array.isArray(majorNames)) majorNames = [];
      } catch (_) {}
    }
    if (majorNames.length === 0) {
      res.send({ code: 500, msg: "未能解析到招生专业列表，请稍后重试或手动填写专业" });
      return;
    }
    for (const major of majorNames) {
      const majorStr = String(major).trim();
      if (!majorStr) continue;
      try {
        const { majorId, programData } = await getOrCreateMajorAndProgramData(majorStr, name);
        if (await schoolProgramExists(majorId, name)) {
          results.push({ major: majorStr, status: 'skipped', msg: '该院校该专业已录入' });
          continue;
        }
        await new Promise((resolve, reject) => {
          const sql = `INSERT INTO school_programs (major_id, school_name, school_level, location, program_features, courses, course_intros, admission_requirements, tuition_fee, scholarships, contact_info) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
          db.run(sql, [
            majorId,
            name,
            programData.school_level || '',
            programData.location || '',
            programData.program_features || '',
            programData.courses || '',
            programData.course_intros || '',
            programData.admission_requirements || '',
            programData.tuition_fee || '',
            programData.scholarships || '',
            programData.contact_info || ''
          ], function (err) {
            if (err) reject(err);
            else resolve(this.lastID);
          });
        });
        db.run(`INSERT IGNORE INTO schools (school_name, school_level, location) VALUES (?, ?, ?)`, [name, programData.school_level || '', programData.location || '']);
        results.push({ major: majorStr, status: 'success' });
      } catch (err) {
        errors.push({ major: majorStr, error: err.message });
      }
    }
    res.send({
      code: 200,
      msg: `已检索并添加完成，成功 ${results.length} 个，失败 ${errors.length} 个`,
      results,
      errors
    });
  } catch (err) {
    console.error("AI 按学校添加所有专业失败:", err);
    const msg = err.message || '';
    const hint = !DEEPSEEK_API_KEY
      ? ' 请在后端服务器（如 115.29.233.160）环境变量中配置 DEEPSEEK_API_KEY。'
      : '';
    res.send({ code: 500, msg: "检索失败: " + msg + hint });
  }
};
app.post('/api/admin/ai-add-school-all-majors', verifyAdmin, handleAiAddSchoolAllMajors);
app.post('/admin/ai-add-school-all-majors', verifyAdmin, handleAiAddSchoolAllMajors);

// ========== 专业动态/新闻 API ==========
// 新闻列表：limit 条数，random=1 随机，major_id 按专业筛
app.get('/api/news', (req, res) => {
  const limit = Math.min(100, parseInt(req.query.limit, 10) || 6);
  const random = req.query.random === '1' || req.query.random === 'true';
  const majorId = req.query.major_id ? parseInt(req.query.major_id, 10) : null;
  let sql = `SELECT * FROM major_news`;
  const params = [];
  if (majorId && !Number.isNaN(majorId)) {
    sql += ` WHERE major_id = ?`;
    params.push(majorId);
  }
  sql += random
    ? ` ORDER BY RAND() LIMIT ?`
    : ` ORDER BY is_hot DESC, publish_date DESC, id DESC LIMIT ?`;
  // mysql2 在 MySQL 8.0.22+ 下 LIMIT ? 需传字符串，否则会报 ER_WRONG_ARGUMENTS
  params.push(String(limit));
  db.all(sql, params, (err, rows) => {
    if (err) {
      console.error("获取新闻失败:", err);
      res.send({ code: 500, msg: "获取失败" });
      return;
    }
    res.send({ code: 200, data: rows || [] });
  });
});

// 单条新闻详情
app.get('/api/news/:id', (req, res) => {
  const newsId = req.params.id;
  const sql = `SELECT * FROM major_news WHERE id = ?`;
  db.get(sql, [newsId], (err, row) => {
    if (err || !row) {
      res.send({ code: 404, msg: "新闻不存在" });
      return;
    }
    res.send({ code: 200, data: row });
  });
});

// ========== 启动 HTTP 服务 / Vercel 导出 ==========
// Vercel 以 serverless 调用，不 listen，只导出 app
if (process.env.VERCEL) {
  module.exports = app;
} else {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ 服务已启动！地址：http://0.0.0.0:${PORT}`);
    console.log(`📊 数据目录: ${DATA_DIR}`);
    console.log(`🤖 智能查询（百炼应用）: ${BAILIAN_API_KEY && BAILIAN_APP_ID ? '已配置' : '未配置'}`);
    console.log(`🤖 DeepSeek（邮箱识别+数据录入）: ${DEEPSEEK_API_KEY ? '已配置' : '未配置'}`);
    // 启动时预建 MySQL 连接池，避免首个请求因懒初始化（建库建表等）而很慢
    if (MYSQL_USER && MYSQL_PASSWORD) {
      initMySQLForKeywords()
        .then(() => console.log('✅ MySQL 连接池已预连接'))
        .catch((e) => console.warn('⚠️ MySQL 预连接失败（首个请求时会再试）:', e.message));
    }
  });
}

// ========== 专业动态管理路由 ==========

// 添加专业动态
app.post('/admin/news', async (req, res) => {
  const { password, major_id, title, content, source, publish_date, is_hot } = req.body;

  // 验证管理员密码
  if (password !== ADMIN_PASSWORD) return res.status(403).json({ code: 403, msg: '密码错误' });

  // 必填字段校验
  if (!major_id || !title) return res.json({ code: 400, msg: 'major_id 和 title 必填' });

  try {
    const [result] = await mysqlPool.execute(
      `INSERT INTO major_news (major_id, title, content, source, publish_date, is_hot)
        VALUES (?, ?, ?, ?, ?, ?)`,
      [major_id, title, content, source, publish_date, is_hot ? 1 : 0]
    );
    res.json({ code: 200, msg: '添加成功', lastID: result.insertId });
  } catch (err) {
    console.error('添加专业动态失败:', err);
    res.json({ code: 500, msg: '存储失败', error: err.message });
  }
});

// 更新专业动态
app.put('/admin/news/:id', async (req, res) => {
  const id = req.params.id;
  const { password, major_id, title, content, source, publish_date, is_hot } = req.body;

  if (password !== ADMIN_PASSWORD) return res.status(403).json({ code: 403, msg: '密码错误' });
  if (!major_id || !title) return res.json({ code: 400, msg: 'major_id 和 title 必填' });

  try {
    const [result] = await mysqlPool.execute(
      `UPDATE major_news
        SET major_id=?, title=?, content=?, source=?, publish_date=?, is_hot=?
        WHERE id=?`,
      [major_id, title, content, source, publish_date, is_hot ? 1 : 0, id]
    );
    res.json({ code: 200, msg: '更新成功' });
  } catch (err) {
    console.error('更新专业动态失败:', err);
    res.json({ code: 500, msg: '更新失败', error: err.message });
  }
});

// 删除专业动态
app.delete('/admin/news/:id', async (req, res) => {
  const id = req.params.id;
  const { password } = req.body;

  if (password !== ADMIN_PASSWORD) return res.status(403).json({ code: 403, msg: '密码错误' });

  try {
    const [result] = await mysqlPool.execute(
      `DELETE FROM major_news WHERE id=?`,
      [id]
    );
    res.json({ code: 200, msg: '删除成功' });
  } catch (err) {
    console.error('删除专业动态失败:', err);
    res.json({ code: 500, msg: '删除失败', error: err.message });
  }
});
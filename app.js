/**
 * ============================================================
 * 志愿填报参考 - 后端主程序 (app.js)
 * ============================================================
 * 这是一个 Node.js 后端服务，用 Express 框架提供网页接口（API），
 * 用 MySQL 存数据。主要功能包括：
 * - 在读分享/学生分享的增删查
 * - 智能查询（Stepfun 阶跃星辰）
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

// ===== 加载环境变量（Vercel 等已有环境变量平台跳过）=====
if (!process.env.VERCEL) {
  try {
    require('dotenv').config();
  } catch (_) {
    // dotenv 未安装时静默跳过，不阻塞启动
  }
}

// ===== 安全中间件：请求体大小限制 与 基础防护 =====
// 请求体解析已在顶部配置，此处仅补充安全头与限流
let helmet, rateLimit;
try { helmet = require('helmet'); } catch (_) {}
try { rateLimit = require('express-rate-limit'); } catch (_) {}

if (helmet) {
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:"],
        styleSrc: ["'self'", "'unsafe-inline'"],
      }
    }
  }));
}

// 通用限流：全局 API 保护（限制过于激进的暴力请求）
if (rateLimit) {
  const globalLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      res.status(429).json({ code: 429, msg: '请求过于频繁，请稍后再试' });
    }
  });
  app.use(globalLimiter);

  // 认证相关接口：更严格
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    handler: (req, res) => {
      res.status(429).json({ code: 429, msg: '请求过于频繁，请稍后再试' });
    }
  });
  app.use('/api/auth/', authLimiter);
  app.use('/api/admin/login', authLimiter);
  app.use('/admin/student-id-review', authLimiter);
}

// ===== CORS 白名单（默认生产环境只允许配置域）=====
const CORS_ORIGINS = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
  : process.env.NODE_ENV === 'production' ? [] : ['http://localhost:3000'];

if (CORS_ORIGINS.length > 0) {
  app.use(cors({ origin: CORS_ORIGINS, credentials: true }));
} else {
  // 生产环境未配置时，仅允许同域（避免完全开放）
  app.use(cors({ origin: true, credentials: true }));
}
console.log('[CORS] 允许的域名:', CORS_ORIGINS.length ? CORS_ORIGINS.join(', ') : '同域（未配置白名单）');

// 【必须放在所有路由/中间件之前】放大请求体限制，避免学生证 base64 图片触发 PayloadTooLargeError
const BODY_LIMIT_RAW = process.env.BODY_LIMIT;
const BODY_LIMIT =
  !BODY_LIMIT_RAW
    ? '250mb'
    : BODY_LIMIT_RAW === 'unlimited'
      ? '1024mb'
      : BODY_LIMIT_RAW;
app.use(express.json({ limit: BODY_LIMIT }));
app.use(express.urlencoded({ limit: BODY_LIMIT, extended: true }));
console.log('[Express] 请求体大小限制:', BODY_LIMIT);

// ----- 基础配置：从环境变量读取，没有则用默认值 -----
const PORT = process.env.PORT || 3000;   // 服务监听的端口号

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

// ----- 阿里云百炼（千问）配置：仅用于学生证鉴伪、发帖/评论审核；智能查询已改用 Stepfun -----
const BAILIAN_API_KEY = process.env.BAILIAN_API_KEY || process.env.DIRECT_AI_KEY;
const DASHSCOPE_VISION_MODEL = process.env.DASHSCOPE_VISION_MODEL || 'qwen-vl-plus'; // 学生证视觉模型
const DASHSCOPE_BASE = 'https://dashscope.aliyuncs.com';
// 认证 token 有效期：10 年，认证后长期有效，用于发帖、举报等
const TOKEN_EXPIRY_MS = 10 * 365 * 24 * 60 * 60 * 1000;

// 学生分享：有用度低于此阈值视为无用；新帖宽限期（分钟）内不因分析结果被过滤

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
const MYSQL_HOST = process.env.MYSQL_HOST; // 无默认值，必须配置
const MYSQL_PORT = parseInt(process.env.MYSQL_PORT || '3306', 10);
const MYSQL_USER = process.env.MYSQL_USER;       // 必须在环境变量中设置
const MYSQL_PASSWORD = process.env.MYSQL_PASSWORD; // 必须在环境变量中设置
const MYSQL_DATABASE = process.env.MYSQL_DATABASE || 'ycyz_db';

if (!MYSQL_HOST || !MYSQL_USER || !MYSQL_PASSWORD) {
  console.error('❌ MySQL 配置不完整，请设置 MYSQL_HOST、MYSQL_USER、MYSQL_PASSWORD 环境变量');
  process.exit(1);
}

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

// ===== 加载模块化路由（渐进式迁移）=====
const authRouter = require('./server/routes/auth');
app.use('/api/auth', authRouter);

const sharesRouter = require('./server/routes/shares');
app.use('/api', sharesRouter);

const adminRouter = require('./server/routes/admin');
app.use(adminRouter);

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
// 与列表接口一致：已通过、未到删除时间，且（新帖宽限期内 或 有用度达标且非情绪化）

// POST /ai-query：智能查询。使用 Stepfun，含学生分享总结（按学校/关键词热度 top100）、联网搜索、可选锚定 gov.cn/edu.cn、知识库
const { handleStepfunAiQuery } = require('./stepfun-ai');
const aiQueryHelpers = { getSchoolFromPrompt: sharesRouter.getSchoolFromPrompt, fetchTopSharesBySchool: sharesRouter.fetchTopSharesBySchool, fetchTopSharesByKeyword: sharesRouter.fetchTopSharesByKeyword };
app.post('/ai-query', (req, res) => {
  handleStepfunAiQuery(req, res, aiQueryHelpers).catch((err) => {
    console.error('智能查询失败:', err);
    res.send({ code: 500, msg: '智能查询失败: ' + (err.message || String(err)) });
  });
});
app.post('/ai-query-step', (req, res) => {
  handleStepfunAiQuery(req, res, aiQueryHelpers).catch((err) => {
    console.error('Stepfun 智能查询异常:', err);
    res.send({ code: 500, msg: '智能查询失败: ' + (err.message || String(err)) });
  });
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
// ========== 学生分享调试接口（生产环境建议关闭）==========
// 直接查询数据库，不应用复杂的过滤条件

// 多张图片存一个字段时用此分隔符（因为 base64 里本身有逗号）

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

// GET 后端配置检查（不暴露密钥）：用于确认当前请求是否到达正确后端及 SMTP/百炼/Stepfun 是否已配置
app.get('/api/auth/backend-config', (req, res) => {
  res.send({
    code: 200,
    smtpConfigured: !!transporter,
    bailianConfigured: !!BAILIAN_API_KEY,
    stepfunConfigured: !!process.env.STEPFUN_API_KEY,
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

      // 允许同一邮箱反复认证：用 REPLACE 覆盖旧记录（uk_verified_email 唯一键冲突时会先删后插）
      db.run(
        'REPLACE INTO verified_users (email, school_name, auth_type, auth_token, token_expires_at, nickname) VALUES (?, ?, ?, ?, ?, ?)',
        [emailLower, schoolName, 'email', authToken, toMySQLDateTime(tokenExpiresAt), nick],
        (replaceErr) => {
          if (replaceErr) {
            res.send({ code: 500, msg: "认证失败" });
            return;
          }
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
    // 识别为“否/不真实”也不直接拒绝用户：统一返回 review 给人工审核
    if (/^否|不真实|假|非学生证/.test(text)) return 'review';
    if (/否|不真实|假|非学生证|no|false/.test(text)) return 'review';
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
  if (!rawBase64) {
    res.send({ code: 400, msg: "请上传学生证图片" });
    return;
  }

  // 百炼视觉鉴伪使用 base64 上传，单张图片过大时可能无法送检；
  // 此类情况不能直接拒绝用户，应保存并进入后台人工审核。
  const MAX_RAW_BASE64_FOR_AI = 4 * 1024 * 1024;
  const manualDueToSize = rawBase64.length > MAX_RAW_BASE64_FOR_AI;

  let status = 'pending_manual';
  // 1) 学生证图片发给 AI（百炼千问视觉）鉴伪
  if (!manualDueToSize) {
    try {
      const aiResult = await callBailianVisionStudentId(rawBase64);
      console.log('[学生证] 百炼鉴伪结果:', aiResult);
      if (aiResult === 'pass') status = 'approved';
      else status = 'pending_manual'; // review/不确定 -> 人工审核
    } catch (e) {
      console.error("[学生证] AI 鉴伪异常，转人工:", e.message);
    }
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
      } else {
        const msg = manualDueToSize
          ? "图片过大，无法送检百炼鉴伪，将提交后台人工审核。"
          : "已提交，等待人工审核";
        res.send({ code: 200, submissionId: id, status: 'pending_manual', msg });
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

// ========== 全局错误处理（用于定位 request aborted / body 解析失败） ==========
// 常见于：客户端在上传/提交请求体时中断（超时、刷新、切换页面、网络抖动等）
app.use((err, req, res, next) => {
  try {
    const isAborted =
      (err && typeof err.message === 'string' && err.message.toLowerCase().includes('request aborted')) ||
      err?.type === 'entity.aborted';
    if (isAborted) {
      console.error('[BodyParser] request aborted:', {
        method: req.method,
        url: req.originalUrl || req.url,
        contentLength: req.headers['content-length'],
        contentType: req.headers['content-type'],
        ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress,
        err: err && { name: err.name, message: err.message, type: err.type }
      });
    } else {
      // 仅对你关心的 body 解析异常做日志；避免刷屏
      if (err?.type || (err && err.message && err.message.length < 200)) {
        console.error('[Error]', { method: req.method, url: req.originalUrl || req.url, type: err.type, message: err.message });
      } else {
        console.error('[Error]', err);
      }
    }
  } catch (_) {}

  res.status(400).send({ code: 400, msg: err && err.message ? err.message : 'Bad Request' });
});

// ========== 启动 HTTP 服务 / Vercel 导出 ==========
// Vercel 以 serverless 调用，不 listen，只导出 app
if (process.env.VERCEL) {
  module.exports = app;
} else {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ 服务已启动！地址：http://0.0.0.0:${PORT}`);
    console.log(`📊 数据目录: ${DATA_DIR}`);
    console.log(`🤖 智能查询（Stepfun）: ${process.env.STEPFUN_API_KEY ? '已配置' : '未配置'}`);
    console.log(`🤖 百炼（学生证/审核）: ${BAILIAN_API_KEY ? '已配置' : '未配置'}`);
    console.log(`🤖 智能查询（Stepfun）: ${process.env.STEPFUN_API_KEY ? '已配置，可用 /ai-query-step' : '未配置'}`);
    console.log(`🤖 DeepSeek（邮箱识别+数据录入）: ${DEEPSEEK_API_KEY ? '已配置' : '未配置'}`);
    // 启动时预建 MySQL 连接池，避免首个请求因懒初始化（建库建表等）而很慢
    if (MYSQL_USER && MYSQL_PASSWORD) {
      initMySQLForKeywords()
        .then(() => console.log('✅ MySQL 连接池已预连接'))
        .catch((e) => console.warn('⚠️ MySQL 预连接失败（首个请求时会再试）:', e.message));
    }
  });
}

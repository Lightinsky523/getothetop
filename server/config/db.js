/**
 * 数据库配置与连接池
 * 提供 MySQL 连接池、SQLite 兼容 API 封装（db.run/db.all/db.get）
 */

const mysql = require('mysql2/promise');
const path = require('path');
const fs = require('fs');

// ----- MySQL 配置 -----
const MYSQL_HOST = process.env.MYSQL_HOST;
const MYSQL_PORT = parseInt(process.env.MYSQL_PORT || '3306', 10);
const MYSQL_USER = process.env.MYSQL_USER;
const MYSQL_PASSWORD = process.env.MYSQL_PASSWORD;
const MYSQL_DATABASE = process.env.MYSQL_DATABASE || 'ycyz_db';

if (!MYSQL_HOST || !MYSQL_USER || !MYSQL_PASSWORD) {
  console.error('❌ MySQL 配置不完整，请设置 MYSQL_HOST、MYSQL_USER、MYSQL_PASSWORD 环境变量');
  process.exit(1);
}

let mysqlPool = null;

// 默认关键词与分类
const DEFAULT_KEYWORD_CATEGORY_PAIRS = [
  { keyword: '学业', category: '学习与成绩' },
  { keyword: '课程', category: '学习与成绩' },
  { keyword: '保研', category: '学习与成绩' },
  { keyword: '就业', category: '学习与成绩' },
  { keyword: '面试', category: '学习与成绩' },
  { keyword: '压力', category: '学习与成绩' },
  { keyword: '位次', category: '学习与成绩' },
  { keyword: '学习', category: '学习与成绩' },
  { keyword: '高考', category: '学习与成绩' },
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
  { keyword: '住宿费', category: '费用与资助' },
  { keyword: '学费', category: '费用与资助' },
  { keyword: '奖学金', category: '费用与资助' },
  { keyword: '助学贷款', category: '费用与资助' },
  { keyword: '助学金', category: '费用与资助' },
  { keyword: '勤工俭学', category: '费用与资助' },
  { keyword: '校园卡', category: '费用与资助' },
  { keyword: '校园网', category: '费用与资助' },
  { keyword: '招聘', category: '发展与机会' },
  { keyword: '创业', category: '发展与机会' },
  { keyword: '创新', category: '发展与机会' },
  { keyword: '竞赛', category: '发展与机会' },
  { keyword: '比赛', category: '发展与机会' },
  { keyword: '社团', category: '发展与机会' },
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
const KEYWORD_CATEGORIES_CACHE_TTL_MS = 10 * 60 * 1000;
let keywordCachePromise = null;

/** MySQL DATETIME 只接受 'YYYY-MM-DD HH:MM:SS' */
function toMySQLDateTime(dateOrIso) {
  const d = dateOrIso instanceof Date ? dateOrIso : new Date(dateOrIso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function toTinyInt(v) {
  return (v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true') ? 1 : 0;
}

function ensureMySQLParams(params) {
  if (!Array.isArray(params)) return params || [];
  return params.map((p) => {
    if (p instanceof Date) return toMySQLDateTime(p);
    if (typeof p === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(p)) return toMySQLDateTime(p);
    return p;
  });
}

async function initMySQLForKeywords() {
  if (mysqlPool) return mysqlPool;
  try {
    const baseConfig = {
      host: MYSQL_HOST,
      port: MYSQL_PORT,
      user: MYSQL_USER,
      password: MYSQL_PASSWORD,
      connectTimeout: 10000
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

    // 创建所有业务表
    const tables = [
      `CREATE TABLE IF NOT EXISTS keyword_categories (
        id INT AUTO_INCREMENT PRIMARY KEY,
        keyword VARCHAR(255) NOT NULL,
        category VARCHAR(255) NOT NULL,
        UNIQUE KEY uk_keyword (keyword)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,
      `CREATE TABLE IF NOT EXISTS user_uploads (
        id INT AUTO_INCREMENT PRIMARY KEY,
        school VARCHAR(255), major VARCHAR(255), city VARCHAR(255), gaokao_year INT,
        experience TEXT, label VARCHAR(255),
        upload_time DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,
      `CREATE TABLE IF NOT EXISTS student_shares (
        id INT AUTO_INCREMENT PRIMARY KEY,
        school VARCHAR(255), major VARCHAR(255), grade VARCHAR(255), title VARCHAR(255),
        content LONGTEXT, tags TEXT, images LONGTEXT,
        status VARCHAR(50) DEFAULT 'approved',
        upload_time DATETIME DEFAULT CURRENT_TIMESTAMP,
        author_nickname VARCHAR(255), share_number INT UNIQUE,
        usefulness_ratio DOUBLE, is_emotional TINYINT DEFAULT 0,
        analyzed_at DATETIME, delete_after DATETIME
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,
      `CREATE TABLE IF NOT EXISTS verification_codes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(255) NOT NULL, code VARCHAR(32) NOT NULL,
        school_name VARCHAR(255), expires_at DATETIME NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,
      `CREATE TABLE IF NOT EXISTS verified_users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(255) NOT NULL, school_name VARCHAR(255) NOT NULL,
        auth_type VARCHAR(50) DEFAULT 'email', auth_token VARCHAR(255) NOT NULL,
        token_expires_at DATETIME NOT NULL, verified_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        nickname VARCHAR(255),
        UNIQUE KEY uk_verified_email (email), UNIQUE KEY uk_verified_token (auth_token)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,
      `CREATE TABLE IF NOT EXISTS student_id_verifications (
        id INT AUTO_INCREMENT PRIMARY KEY,
        school_name VARCHAR(255) NOT NULL, image_data LONGTEXT,
        status VARCHAR(50) NOT NULL DEFAULT 'pending_manual',
        auth_token VARCHAR(255), token_expires_at DATETIME,
        ali_task_id VARCHAR(255), nickname VARCHAR(255),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,
      `CREATE TABLE IF NOT EXISTS share_reports (
        id INT AUTO_INCREMENT PRIMARY KEY,
        share_id INT NOT NULL, user_email VARCHAR(255) NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_share_reports_share_id (share_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,
      `CREATE TABLE IF NOT EXISTS share_likes (
        share_id INT NOT NULL, user_email VARCHAR(255) NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (share_id, user_email)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,
      `CREATE TABLE IF NOT EXISTS share_comments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        share_id INT NOT NULL, parent_id INT NULL,
        user_email VARCHAR(255) NOT NULL, school_name VARCHAR(255) NOT NULL,
        nickname VARCHAR(255) NOT NULL, content TEXT NOT NULL,
        status VARCHAR(50) DEFAULT 'approved', like_count INT DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        usefulness_ratio DOUBLE, is_emotional TINYINT DEFAULT 0,
        analyzed_at DATETIME, delete_after DATETIME,
        INDEX idx_share_comments_share_id (share_id),
        INDEX idx_share_comments_parent_id (parent_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,
      `CREATE TABLE IF NOT EXISTS comment_reports (
        id INT AUTO_INCREMENT PRIMARY KEY,
        comment_id INT NOT NULL, user_email VARCHAR(255) NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_comment_reports_comment_id (comment_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,
      `CREATE TABLE IF NOT EXISTS comment_likes (
        comment_id INT NOT NULL, user_email VARCHAR(255) NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (comment_id, user_email)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,
      `CREATE TABLE IF NOT EXISTS schools (
        id INT AUTO_INCREMENT PRIMARY KEY,
        school_name VARCHAR(255) NOT NULL, school_level VARCHAR(255),
        location VARCHAR(255), description TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_school_name (school_name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,
      `CREATE TABLE IF NOT EXISTS school_major_programs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        school_name VARCHAR(255) NOT NULL, major_id INT, major_name VARCHAR(255),
        program_features TEXT, courses TEXT, stream_division VARCHAR(255),
        admission_requirements TEXT, tuition_fee VARCHAR(255),
        scholarships VARCHAR(255), contact_info TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,
      `CREATE TABLE IF NOT EXISTS major_overviews (
        id INT AUTO_INCREMENT PRIMARY KEY,
        major_code VARCHAR(255) UNIQUE, major_name VARCHAR(255) NOT NULL,
        category VARCHAR(255), degree_type VARCHAR(255), duration VARCHAR(255),
        description TEXT, core_courses TEXT, career_prospects TEXT, related_majors TEXT,
        training_plan TEXT, admission_plan TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,
      `CREATE TABLE IF NOT EXISTS school_programs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        major_id INT, school_name VARCHAR(255) NOT NULL, school_level VARCHAR(255),
        location VARCHAR(255), program_features TEXT, courses TEXT, course_intros TEXT,
        admission_requirements TEXT, tuition_fee VARCHAR(255), scholarships VARCHAR(255),
        contact_info TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,
      `CREATE TABLE IF NOT EXISTS major_news (
        id INT AUTO_INCREMENT PRIMARY KEY,
        major_id INT, title VARCHAR(255) NOT NULL, content TEXT,
        source VARCHAR(255), publish_date VARCHAR(64), is_hot TINYINT DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`
    ];

    for (const sql of tables) {
      await mysqlPool.query(sql);
    }

    // 添加性能索引（忽略已存在错误）
    const indexes = [
      'ALTER TABLE verified_users ADD INDEX idx_auth_token (auth_token)',
      'ALTER TABLE student_shares ADD INDEX idx_shares_list (status, delete_after, upload_time)',
      'ALTER TABLE student_shares ADD INDEX idx_shares_school (school, status)',
      'ALTER TABLE student_shares ADD INDEX idx_shares_major (major, status)',
      'ALTER TABLE student_shares ADD INDEX idx_shares_search (title, content, tags)',
      'ALTER TABLE share_comments ADD INDEX idx_comments_share (share_id, status, created_at)',
      'ALTER TABLE share_reports ADD INDEX idx_reports_share (share_id)',
      'ALTER TABLE comment_reports ADD INDEX idx_reports_comment (comment_id)',
      'ALTER TABLE major_overviews ADD INDEX idx_major_name (major_name)',
      'ALTER TABLE major_overviews ADD INDEX idx_major_category (category)',
      'ALTER TABLE school_programs ADD INDEX idx_programs_school (school_name, major_id)',
      'ALTER TABLE major_news ADD INDEX idx_news_major (major_id, is_hot, publish_date)',
      'ALTER TABLE schools ADD INDEX idx_school_name (school_name)',
      'ALTER TABLE student_id_verifications ADD INDEX idx_student_id_status (status, created_at)',
      'ALTER TABLE verification_codes ADD INDEX idx_verification_email (email, code, expires_at)'
    ];
    for (const idxSql of indexes) {
      try {
        await mysqlPool.query(idxSql);
      } catch (idxErr) {
        // 1061 = ER_DUP_KEYNAME（索引已存在），忽略其他报错
        if (idxErr.code !== 'ER_DUP_KEYNAME') {
          console.warn('[DB] 创建索引失败:', idxSql, idxErr.message);
        }
      }
    }

    // 初始化默认关键词
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
    console.error('❌ 连接 MySQL 或初始化失败：', e.message);
    mysqlPool = null;
  }
  return mysqlPool;
}

async function loadKeywordCategories() {
  const now = Date.now();
  if (keywordCategoriesCache && now - keywordCategoriesCacheTime < KEYWORD_CATEGORIES_CACHE_TTL_MS) {
    return keywordCategoriesCache;
  }
  if (keywordCachePromise) {
    return keywordCachePromise;
  }
  keywordCachePromise = (async () => {
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
            if (!byCategory[cat].includes(kw)) byCategory[cat].push(kw);
          }
        }
      } catch (e) {
        console.error('从 MySQL 读取关键词失败，将使用内置默认关键词：', e.message);
      }
    }
    if (!Object.keys(byCategory).length) {
      for (const pair of DEFAULT_KEYWORD_CATEGORY_PAIRS) {
        const cat = pair.category || '未分类';
        if (!byCategory[cat]) byCategory[cat] = [];
        if (!byCategory[cat].includes(pair.keyword)) byCategory[cat].push(pair.keyword);
      }
    }
    keywordCategoriesCache = byCategory;
    keywordCategoriesCacheTime = now;
    return byCategory;
  })().finally(() => { keywordCachePromise = null; });
  return keywordCachePromise;
}

// 兼容 SQLite API 的 MySQL 封装
const db = {
  run(sql, params, callback) {
    if (typeof params === 'function') { callback = params; params = []; }
    const safeParams = ensureMySQLParams(params);
    initMySQLForKeywords()
      .then(() => mysqlPool.execute(sql, safeParams))
      .then(([result]) => {
        if (!callback) return;
        callback.call({ lastID: result.insertId, changes: result.affectedRows }, null);
      })
      .catch((err) => {
        console.error('db.run error:', err);
        if (callback) callback(err);
      });
  },
  all(sql, params, callback) {
    if (typeof params === 'function') { callback = params; params = []; }
    const safeParams = ensureMySQLParams(params);
    initMySQLForKeywords()
      .then(() => mysqlPool.execute(sql, safeParams))
      .then(([rows]) => { if (callback) callback(null, rows); })
      .catch((err) => {
        console.error('db.all error:', err);
        if (callback) callback(err);
      });
  },
  get(sql, params, callback) {
    if (typeof params === 'function') { callback = params; params = []; }
    const safeParams = ensureMySQLParams(params);
    initMySQLForKeywords()
      .then(() => mysqlPool.execute(sql, safeParams))
      .then(([rows]) => { if (callback) callback(null, rows[0] || null); })
      .catch((err) => {
        console.error('db.get error:', err);
        if (callback) callback(err);
      });
  }
};

module.exports = {
  db,
  mysqlPool: () => mysqlPool,
  initMySQLForKeywords,
  loadKeywordCategories,
  toMySQLDateTime,
  toTinyInt,
  ensureMySQLParams,
  DEFAULT_KEYWORD_CATEGORY_PAIRS
};

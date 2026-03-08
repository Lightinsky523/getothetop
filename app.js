const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const app = express();

// 从环境变量读取配置
const PORT = process.env.PORT || 7860;

// 无法使用创空间终端时：优先用 DATA_DIR；或设置 AUTO_CLONE_DATASET 尝试自动克隆；或设置 DATASET_MOUNT_PATH 使用创空间已挂载的数据集路径
function resolveDataDir() {
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

// 阿里云百炼 - 志愿填报「智能查询」+ 学生证 AI 鉴伪（千问）
const BAILIAN_API_KEY = process.env.BAILIAN_API_KEY || process.env.DIRECT_AI_KEY || 'sk-67367e61ed2e4e28a49b7b1fd5a346b2';
const BAILIAN_APP_ID = process.env.BAILIAN_APP_ID || '1a5d7eb76b1f4c86961d372c6d134b9b';
const DASHSCOPE_BASE = 'https://dashscope.aliyuncs.com';
// 认证 token 与认证状态一致：一旦认证则长期有效（10 年），持有有效 token 即可发帖、举报
const TOKEN_EXPIRY_MS = 10 * 365 * 24 * 60 * 60 * 1000;

// 旧配置保留（管理后台等如仍用可读环境变量）
const AI_API_KEY = process.env.AI_KEY;
const AI_API_URL = process.env.AI_API_URL || 'http://116.62.36.98:3001/api/v1/workspace/project/chat';

// DeepSeek 配置 - 用于邮箱后缀识别学校、专业数据录入（单条/批量/按学校添加）
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_KEY;
const DEEPSEEK_API_URL = process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/v1/chat/completions';
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

// 确保数据目录存在
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// SQLite 数据库路径
const DB_PATH = path.join(DATA_DIR, 'study_experience.db');

// 允许网页跨域访问
app.use(cors());
// 解析网页提交的信息（学生分享含 base64 图片时 body 较大，提高限制）
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// 提供静态文件服务（前端页面）
app.use(express.static(path.join(__dirname)));

// 邮件发送配置（可选，未配置时验证码在响应中返回，便于开发测试）
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER;

// 连接 SQLite 数据库
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error("数据库连接失败：", err);
  } else {
    console.log("✅ SQLite 数据库连接成功！");
    
    // 创建在读分享表（如果不存在）
    db.run(`CREATE TABLE IF NOT EXISTS user_uploads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      school TEXT,
      major TEXT,
      city TEXT,
      gaokao_year INTEGER,
      experience TEXT,
      label TEXT,
      upload_time DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
      if (err) {
        console.error("创建在读分享表失败：", err);
      } else {
        console.log("✅ 在读分享表初始化成功！");
      }
    });

    // 创建学生分享表（如果不存在）- 用于长篇分享
    db.run(`CREATE TABLE IF NOT EXISTS student_shares (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      school TEXT,
      major TEXT,
      grade TEXT,
      title TEXT,
      content TEXT,
      tags TEXT,
      images TEXT,
      status TEXT DEFAULT 'approved',
      upload_time DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
      if (err) {
        console.error("创建学生分享表失败:", err);
      } else {
        console.log("✅ 学生分享表初始化成功！");
      }
      db.run(`ALTER TABLE student_shares ADD COLUMN author_nickname TEXT`, () => {});
      db.run(`ALTER TABLE student_shares ADD COLUMN share_number INTEGER UNIQUE`, () => {});
      db.run(`ALTER TABLE student_shares ADD COLUMN usefulness_ratio REAL`, () => {});
      db.run(`ALTER TABLE student_shares ADD COLUMN is_emotional INTEGER DEFAULT 0`, () => {});
      db.run(`ALTER TABLE student_shares ADD COLUMN analyzed_at DATETIME`, () => {});
      db.run(`ALTER TABLE student_shares ADD COLUMN delete_after DATETIME`, () => {});
      db.run(`UPDATE student_shares SET share_number = id WHERE share_number IS NULL`, () => {});
    });

    // 信息认证：验证码表
    db.run(`CREATE TABLE IF NOT EXISTS verification_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      code TEXT NOT NULL,
      school_name TEXT,
      expires_at DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
      if (err) console.error("创建验证码表失败:", err);
      else console.log("✅ 验证码表初始化成功！");
    });

    // 信息认证：已认证用户（邮箱或学生证）
    db.run(`CREATE TABLE IF NOT EXISTS verified_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      school_name TEXT NOT NULL,
      auth_type TEXT DEFAULT 'email',
      auth_token TEXT NOT NULL,
      token_expires_at DATETIME NOT NULL,
      verified_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
      if (err) console.error("创建已认证用户表失败:", err);
      else console.log("✅ 已认证用户表初始化成功！");
    });
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_verified_users_token ON verified_users(auth_token)`, () => {});
    db.run(`ALTER TABLE verified_users ADD COLUMN auth_type TEXT DEFAULT 'email'`, (err) => { if (err && !String(err.message).includes('duplicate')) console.error("add auth_type:", err); });
    db.run(`ALTER TABLE verified_users ADD COLUMN nickname TEXT`, (err) => { if (err && !String(err.message).includes('duplicate')) console.error("add nickname:", err); });

    // 学生证认证：待审核/已通过/已拒绝（AI 或人工）
    db.run(`CREATE TABLE IF NOT EXISTS student_id_verifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      school_name TEXT NOT NULL,
      image_data TEXT,
      status TEXT NOT NULL DEFAULT 'pending_manual',
      auth_token TEXT,
      token_expires_at DATETIME,
      ali_task_id TEXT,
      nickname TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
      if (err) console.error("创建学生证认证表失败:", err);
      else console.log("✅ 学生证认证表初始化成功！");
      db.run(`ALTER TABLE student_id_verifications ADD COLUMN nickname TEXT`, () => {});
    });

    // 帖子举报表（举报次数>50的帖子进入后台审核可删）
    db.run(`CREATE TABLE IF NOT EXISTS share_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      share_id INTEGER NOT NULL,
      user_email TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (share_id) REFERENCES student_shares(id)
    )`, () => {});

    // 帖子点赞表
    db.run(`CREATE TABLE IF NOT EXISTS share_likes (
      share_id INTEGER NOT NULL,
      user_email TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (share_id, user_email),
      FOREIGN KEY (share_id) REFERENCES student_shares(id)
    )`, () => {});

    // 评论表（parent_id 为 NULL 表示一级评论，非空表示回复）
    db.run(`CREATE TABLE IF NOT EXISTS share_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      share_id INTEGER NOT NULL,
      parent_id INTEGER,
      user_email TEXT NOT NULL,
      school_name TEXT NOT NULL,
      nickname TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT DEFAULT 'approved',
      like_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (share_id) REFERENCES student_shares(id),
      FOREIGN KEY (parent_id) REFERENCES share_comments(id)
    )`, () => {});
    db.run(`ALTER TABLE share_comments ADD COLUMN usefulness_ratio REAL`, () => {});
    db.run(`ALTER TABLE share_comments ADD COLUMN is_emotional INTEGER DEFAULT 0`, () => {});
    db.run(`ALTER TABLE share_comments ADD COLUMN analyzed_at DATETIME`, () => {});
    db.run(`ALTER TABLE share_comments ADD COLUMN delete_after DATETIME`, () => {});

    // 评论举报表
    db.run(`CREATE TABLE IF NOT EXISTS comment_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      comment_id INTEGER NOT NULL,
      user_email TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (comment_id) REFERENCES share_comments(id)
    )`, () => {});

    // 评论点赞表
    db.run(`CREATE TABLE IF NOT EXISTS comment_likes (
      comment_id INTEGER NOT NULL,
      user_email TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (comment_id, user_email),
      FOREIGN KEY (comment_id) REFERENCES share_comments(id)
    )`, () => {});

    // 创建学校信息表
    db.run(`CREATE TABLE IF NOT EXISTS schools (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      school_name TEXT UNIQUE NOT NULL,
      school_level TEXT,
      location TEXT,
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
      if (err) {
        console.error("创建学校表失败:", err);
      } else {
        console.log("✅ 学校表初始化成功！");
      }
    });
    
    // 创建学校专业关联表
    db.run(`CREATE TABLE IF NOT EXISTS school_major_programs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      school_name TEXT NOT NULL,
      major_id INTEGER,
      major_name TEXT,
      program_features TEXT,
      courses TEXT,
      stream_division TEXT,
      admission_requirements TEXT,
      tuition_fee TEXT,
      scholarships TEXT,
      contact_info TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (major_id) REFERENCES major_overviews(id)
    )`, (err) => {
      if (err) {
        console.error("创建学校专业关联表失败:", err);
      } else {
        console.log("✅ 学校专业关联表初始化成功！");
      }
    });
  }
});

// ********** 功能1：接收网页提交的用户信息，存到 SQLite **********
app.post('/save-data', (req, res) => {
  const { school, major, city, gaokao_year, experience, label } = req.body;
  const sql = `INSERT INTO user_uploads (school, major, city, gaokao_year, experience, label) VALUES (?, ?, ?, ?, ?, ?)`;
  db.run(sql, [school, major, city, gaokao_year, experience, label], function(err) {
    if (err) {
      console.error("存数据失败:", err);
      res.send({ code: 500, msg: "存数据失败" });
      return;
    }
    res.send({ code: 200, msg: "存数据成功！" });
  });
});

// ********** 功能2：从 SQLite 取数据，返回给网页展示 **********
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

// ********** 功能3：智能查询 - 直连 API + 学生分享筛选与总结 **********
const SHARE_LIST_WHERE = `s.status = 'approved'
  AND (s.usefulness_ratio IS NULL OR s.usefulness_ratio >= 40)
  AND (s.is_emotional IS NULL OR s.is_emotional = 0)
  AND (s.delete_after IS NULL OR datetime(s.delete_after) > datetime('now'))`;

// 从学生分享中出现的学校名里检测用户问题是否涉及具体学校，返回 { school, keyword } 或 null
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

// 按学校（及可选关键词）取点赞数最高的最多 limit 条帖子
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
    params.push(limit);
    db.all(sql, params, (err, rows) => {
      if (err) return resolve([]);
      resolve(rows || []);
    });
  });
}

// 根据用户输入从学生分享中筛选相关帖子，再交给 AI 总结回答（限制条数与长度以降低超时）
// 与列表一致：排除 DeepSeek 判为无用或情绪化的帖子，志愿填报百炼不总结此类内容
function fetchRelevantShares(prompt, limit = 10) {
  return new Promise((resolve) => {
    const where = `status = 'approved'
      AND (usefulness_ratio IS NULL OR usefulness_ratio >= 40)
      AND (is_emotional IS NULL OR is_emotional = 0)
      AND (delete_after IS NULL OR datetime(delete_after) > datetime('now'))`;
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

// 智能查询：调用阿里云百炼「应用」API（千问 + 知识库 + 自建 prompt）
// 若用户问题涉及具体学校，则先对该校学生分享点赞最高的最多 100 条做百炼总结，再与综合回答一起返回
app.post('/ai-query', async (req, res) => {
  const { prompt, profileSummary, isXuanke, xuankeContext } = req.body;
  
  try {
    const fetch = (await import('node-fetch')).default;
    if (!BAILIAN_API_KEY || !BAILIAN_APP_ID) {
      res.send({ code: 500, msg: "智能查询未配置（需 BAILIAN_API_KEY 与 BAILIAN_APP_ID）" });
      return;
    }

    const MAX_SNIPPET = 200;
    const MAX_SUMMARY_SNIPPET = 350;
    let shareSummary = '';

    // 若涉及具体学校：取该校（及关键词）点赞最高的最多 100 条，用百炼总结
    const detected = await getSchoolFromPrompt(prompt);
    if (detected && detected.school) {
      const topShares = await fetchTopSharesBySchool(detected.school, detected.keyword, 100);
      if (topShares.length > 0) {
        const postsText = topShares.map((entry, i) => {
          const contentSnippet = (entry.content || '').slice(0, MAX_SUMMARY_SNIPPET);
          return `[${i + 1}] 点赞${entry.like_count || 0} · ${entry.title || '无标题'}\n${contentSnippet}${(entry.content || '').length > MAX_SUMMARY_SNIPPET ? '…' : ''}`;
        }).join('\n\n');
        const summaryPrompt = `用户问题：${prompt}\n\n请对以下「${detected.school}」学生分享帖子进行总结，围绕用户问题的关注点归纳（如学习压力、宿舍、就业、保研等）。每条帖子已按点赞数从高到低排列，共 ${topShares.length} 条。总结控制在 500 字以内，条理清晰。\n\n帖子内容：\n${postsText.slice(0, 28000)}`;
        const appUrl = `${DASHSCOPE_BASE}/api/v1/apps/${BAILIAN_APP_ID}/completion`;
        try {
          const sumController = new AbortController();
          const sumTimeout = setTimeout(() => sumController.abort(), 60000);
          const sumRes = await fetch(appUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${BAILIAN_API_KEY}` },
            body: JSON.stringify({ input: { prompt: summaryPrompt }, parameters: { result_format: 'message' } }),
            signal: sumController.signal
          });
          clearTimeout(sumTimeout);
          if (sumRes.ok) {
            const sumJson = await sumRes.json();
            const text = sumJson.output?.text || sumJson.output?.choices?.[0]?.message?.content || sumJson.data?.output?.text || sumJson.choices?.[0]?.message?.content;
            if (text && typeof text === 'string') shareSummary = text.trim();
          }
        } catch (e) {
          console.error('该校学生分享总结调用失败:', e.message);
        }
      }
    }

    // 控制上下文长度，减少百炼处理时间，降低超时概率
    const shareRows = await fetchRelevantShares(prompt, 8);
    let contextInfo = "【参考信息】\n";
    if (profileSummary && profileSummary !== "（未填写）") {
      contextInfo += `用户基本信息：${profileSummary}\n`;
    }
    if (isXuanke && xuankeContext) {
      const combo = [xuankeContext.first, ...(xuankeContext.second || [])].filter(Boolean).join("+");
      contextInfo += `选科：首选 ${xuankeContext.first || '未选'}，再选 ${(xuankeContext.second || []).join('、') || '未选'}（${combo}），省份：${xuankeContext.province || '未填'}\n`;
    }
    if (shareSummary) {
      contextInfo += "【基于该校学生分享高赞帖的总结】\n" + shareSummary + "\n";
    }
    if (shareRows.length > 0) {
      contextInfo += "学生分享（供参考）：\n";
      shareRows.forEach((entry, i) => {
        const author = entry.author_nickname || entry.school || '匿名';
        const contentSnippet = (entry.content || '').slice(0, MAX_SNIPPET);
        contextInfo += `[${i + 1}] ${entry.school || ''} · ${entry.major || ''} · ${author}：${entry.title || ''}\n${contentSnippet}${(entry.content || '').length > MAX_SNIPPET ? '…' : ''}\n`;
      });
    }
    contextInfo += `\n用户问题：${prompt}`;

    const appUrl = `${DASHSCOPE_BASE}/api/v1/apps/${BAILIAN_APP_ID}/completion`;
    const callBailian = (signal) => fetch(appUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${BAILIAN_API_KEY}`
      },
      body: JSON.stringify({
        input: { prompt: contextInfo },
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
    try {
      result = JSON.parse(rawText);
    } catch (e) {
      res.send({ code: 500, msg: "AI 响应非 JSON" });
      return;
    }
    const aiText =
      result.output?.text ||
      result.output?.choices?.[0]?.message?.content ||
      result.data?.output?.text ||
      result.choices?.[0]?.message?.content;
    if (aiText) {
      const finalData = shareSummary
        ? `【基于该校学生分享的总结】\n\n${shareSummary}\n\n【综合回答】\n\n${aiText}`
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

// 本地模拟 AI 回复函数
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

// ********** 功能4：保存学生长篇分享（匿名）**********
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

// ********** 功能5：获取学生长篇分享列表**********
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

// ********** 专业概览管理功能 **********

// 创建专业概览表
db.run(`CREATE TABLE IF NOT EXISTS major_overviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  major_code TEXT UNIQUE,
  major_name TEXT NOT NULL,
  category TEXT,
  degree_type TEXT,
  duration TEXT,
  description TEXT,
  core_courses TEXT,
  career_prospects TEXT,
  related_majors TEXT,
  training_plan TEXT,
  admission_plan TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`, (err) => {
  if (err) {
    console.error("创建专业概览表失败:", err);
  } else {
    console.log("✅ 专业概览表初始化成功！");
  }
});
// 兼容旧库：为已有表补充培养方案、招生计划字段
db.run(`ALTER TABLE major_overviews ADD COLUMN training_plan TEXT`, (err) => { if (err && !String(err.message).includes('duplicate')) console.error("添加 training_plan 列:", err); });
db.run(`ALTER TABLE major_overviews ADD COLUMN admission_plan TEXT`, (err) => { if (err && !String(err.message).includes('duplicate')) console.error("添加 admission_plan 列:", err); });

// 创建开设院校表
db.run(`CREATE TABLE IF NOT EXISTS school_programs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  major_id INTEGER,
  school_name TEXT NOT NULL,
  school_level TEXT,
  location TEXT,
  program_features TEXT,
  courses TEXT,
  course_intros TEXT,
  admission_requirements TEXT,
  tuition_fee TEXT,
  scholarships TEXT,
  contact_info TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (major_id) REFERENCES major_overviews(id)
)`, (err) => {
  if (err) {
    console.error("创建开设院校表失败:", err);
  } else {
    console.log("✅ 开设院校表初始化成功！");
  }
});
// 兼容旧库：开设院校表增加课程介绍字段（不删除任何已有数据）
db.run(`ALTER TABLE school_programs ADD COLUMN course_intros TEXT`, (err) => { if (err && !String(err.message).includes('duplicate')) console.error("添加 course_intros 列:", err); });

// 创建专业动态趣闻表
db.run(`CREATE TABLE IF NOT EXISTS major_news (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  major_id INTEGER,
  title TEXT NOT NULL,
  content TEXT,
  source TEXT,
  publish_date TEXT,
  is_hot INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (major_id) REFERENCES major_overviews(id)
)`, (err) => {
  if (err) {
    console.error("创建专业动态表失败:", err);
  } else {
    console.log("✅ 专业动态表初始化成功！");
  }
});

// 管理员验证中间件
const ADMIN_PASSWORD = 'a~a~ycyzword+';
function verifyAdmin(req, res, next) {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) {
    res.send({ code: 403, msg: "密码错误，无权限访问" });
    return;
  }
  next();
}

// 管理员：下载数据库备份（防止重启丢失且无法用终端/自动克隆时，可定期下载到本机保存）
app.get('/admin/backup/download-db', (req, res) => {
  const pwd = req.query.password || (req.body && req.body.password);
  if (pwd !== ADMIN_PASSWORD) {
    res.status(403).send('无权限');
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

// 管理员：待人工审核的学生证列表
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

// 管理员：查看单条学生证图片（base64）
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

// 管理员：通过/拒绝学生证
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
      ['approved', authToken, tokenExpiresAt, id],
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
              'INSERT OR REPLACE INTO verified_users (email, school_name, auth_type, auth_token, token_expires_at, nickname) VALUES (?, ?, ?, ?, ?, ?)',
              [sid, row.school_name, 'student_id', authToken, tokenExpiresAt, nick],
              (e3) => {
                if (e3) console.error('学生证通过-INSERT无auth_type失败:', e3.message);
                res.send(e3 ? { code: 500, msg: "写入用户表失败，请查看服务端日志" } : { code: 200, msg: "已通过", authToken });
              }
            );
            return;
          }
          res.send({ code: 200, msg: "已通过", authToken });
        };
        db.run(
          'INSERT OR REPLACE INTO verified_users (email, school_name, auth_type, auth_token, token_expires_at, nickname) VALUES (?, ?, ?, ?, ?, ?)',
          [sid, row.school_name, 'student_id', authToken, new Date(Date.now() + TOKEN_EXPIRY_MS).toISOString(), nick],
          insertCb
        );
      }
    );
  });
});

// 管理员：获取被举报待审核的帖子（举报次数>50 后 status=pending_review）
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

// 管理员：删帖（用于举报审核后删除）
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

// 管理员：通过待审帖子（分享内容审核：AI 无法辨别或举报过多）
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

// 获取所有专业概览
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

// 添加专业
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
app.put('/admin/programs/:id', verifyAdmin, (req, res) => {
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
app.delete('/admin/programs/:id', verifyAdmin, (req, res) => {
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
app.get('/admin/majors/:id/news', (req, res) => {
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
app.post('/admin/news', verifyAdmin, (req, res) => {
  const { password, major_id, title, content, source, publish_date, is_hot } = req.body;
  
  const sql = `INSERT INTO major_news (major_id, title, content, source, publish_date, is_hot) VALUES (?, ?, ?, ?, ?, ?)`;
  db.run(sql, [major_id, title, content, source, publish_date, is_hot ? 1 : 0], function(err) {
    if (err) {
      console.error("添加专业动态失败:", err);
      res.send({ code: 500, msg: "添加失败: " + err.message });
      return;
    }
    res.send({ code: 200, msg: "添加成功", id: this.lastID });
  });
});

// 更新专业动态趣闻
app.put('/admin/news/:id', verifyAdmin, (req, res) => {
  const { password, title, content, source, publish_date, is_hot } = req.body;
  const id = req.params.id;
  
  const sql = `UPDATE major_news SET title = ?, content = ?, source = ?, publish_date = ?, is_hot = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`;
  db.run(sql, [title, content, source, publish_date, is_hot ? 1 : 0, id], function(err) {
    if (err) {
      console.error("更新专业动态失败:", err);
      res.send({ code: 500, msg: "更新失败: " + err.message });
      return;
    }
    res.send({ code: 200, msg: "更新成功" });
  });
});

// 删除专业动态趣闻
app.delete('/admin/news/:id', verifyAdmin, (req, res) => {
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

// 公开API：获取所有专业概览（用于前端展示）
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

// 公开API：获取某专业详情及开设院校
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

// 公开API：按专业搜索（支持 GET 与 POST，便于前端可靠传参）
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

// ========== 新的学生分享 API ==========

// 获取学生分享列表（支持搜索；含点赞数；有用比率>=40 且非情绪过重且未到删除时间才展示；先执行 24h 到期删除）
app.get('/api/student-shares', async (req, res) => {
  db.run(`UPDATE student_shares SET status = 'deleted' WHERE delete_after IS NOT NULL AND datetime(delete_after) <= datetime('now')`, () => {});
  const { school, major, keyword } = req.query;
  let sql = `SELECT s.*, (SELECT COUNT(*) FROM share_likes sl WHERE sl.share_id = s.id) AS like_count FROM student_shares s WHERE s.status = 'approved'
    AND (s.usefulness_ratio IS NULL OR s.usefulness_ratio >= 40)
    AND (s.is_emotional IS NULL OR s.is_emotional = 0)
    AND (s.delete_after IS NULL OR datetime(s.delete_after) > datetime('now'))`;
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

// 按编号读取帖子（用于按 share_number 锁定对应帖子）
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

// 学生分享图片存储分隔符（data URL 内含逗号，不可用逗号分隔）
const IMAGE_SEP = '|||IMAGE_SEP|||';

// ========== 信息认证（学校邮箱验证） ==========

// 常见邮箱后缀 -> 学校名（AI 失败或返回空/未知时回退）
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

// 根据邮箱后缀识别学校名称：已配置 DeepSeek 时用 AI 识别，否则仅用内置表；含解析增强与回退表
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

// 发送验证码
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

  const schoolName = await getSchoolFromEmailSuffix(suffix);
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

  db.run(
    'INSERT INTO verification_codes (email, code, school_name, expires_at) VALUES (?, ?, ?, ?)',
    [email, code, schoolName, expiresAt],
    async (err) => {
      if (err) {
        console.error("保存验证码失败:", err);
        res.send({ code: 500, msg: "发送失败" });
        return;
      }
      if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
        try {
          const nodemailer = (await import('nodemailer')).default;
          const transporter = nodemailer.createTransport({
            host: SMTP_HOST,
            port: SMTP_PORT,
            secure: SMTP_PORT === 465,
            auth: { user: SMTP_USER, pass: SMTP_PASS }
          });
          await transporter.sendMail({
            from: SMTP_FROM,
            to: email,
            subject: '【志愿填报参考】邮箱验证码',
            text: `您的验证码是：${code}，5 分钟内有效。`
          });
          res.send({ code: 200, msg: "验证码已发送到您的邮箱", school: schoolName });
        } catch (mailErr) {
          console.error("邮件发送失败:", mailErr);
          res.send({ code: 500, msg: "邮件发送失败，请稍后重试" });
        }
      } else {
        console.warn("未配置 SMTP，验证码返回在响应中（仅供测试）");
        res.send({ code: 200, msg: "验证码已生成（未配置邮件服务，测试模式）", school: schoolName, vc: code });
      }
    }
  );
});

// 验证码校验，获得认证（在读生-邮箱认证）
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
    'SELECT school_name FROM verification_codes WHERE email = ? AND code = ? AND expires_at > datetime("now") ORDER BY id DESC LIMIT 1',
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
        [emailLower, schoolName, 'email', authToken, tokenExpiresAt],
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

// 学生证图片发给 AI（百炼千问视觉）做鉴伪
async function callBailianVisionStudentId(imageBase64) {
  if (!BAILIAN_API_KEY) return 'review';
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
        model: 'qwen-vl-plus',
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
    if (!response.ok) return 'review';
    const result = await response.json();
    const text = (result.choices?.[0]?.message?.content || result.output?.text || '').trim();
    if (/是|真实|有效|学生证/.test(text) && !/否|不|假|非/.test(text)) return 'pass';
    if (/否|不|假|非|非学生证/.test(text)) return 'rejected';
  } catch (e) {
    console.error('学生证 AI 视觉鉴伪失败:', e.message);
  }
  return 'review';
}

// 百炼文本内容审核：判断帖子标题+内容是否违规，返回 'pass' | 'block' | 'review'
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

// 阿里云内容安全配置（可选，用于学生证鉴伪）。环境变量名支持 ALIYUN_* 或 ALIBABA_CLOUD_*
const ALIYUN_ACCESS_KEY_ID = process.env.ALIYUN_ACCESS_KEY_ID || process.env.ALIBABA_CLOUD_ACCESS_KEY_ID;
const ALIYUN_ACCESS_KEY_SECRET = process.env.ALIYUN_ACCESS_KEY_SECRET || process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET;
const ALIYUN_GREEN_REGION = process.env.ALIYUN_GREEN_REGION || 'cn-shanghai';

// 学生证认证：提交图片，先走阿里云鉴伪（若已配置），存疑则 pending_manual 等人审（在读生认证）
app.post('/api/auth/student-id', async (req, res) => {
  const { school, imageBase64, nickname } = req.body;
  const schoolName = (school || '').trim();
  const nick = (nickname || '').trim() || '在读生';
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
    if (aiResult === 'pass') status = 'approved';
    else if (aiResult === 'rejected') status = 'rejected';
  } catch (e) {
    console.error("学生证 AI 鉴伪异常，转人工:", e.message);
  }
  // 2) 若已配置阿里云内容安全，再走一遍鉴伪（可与 AI 结果合并）
  if (status === 'pending_manual' && ALIYUN_ACCESS_KEY_ID && ALIYUN_ACCESS_KEY_SECRET) {
    try {
      const greenResult = await callAliyunImageScan(rawBase64);
      if (greenResult === 'pass') status = 'approved';
      else if (greenResult === 'rejected') status = 'rejected';
    } catch (e) {
      console.error("阿里云图片鉴伪失败，转人工:", e.message);
    }
  }

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
          [authToken, tokenExpiresAt, id],
          (updateErr) => {
            if (updateErr) {
              res.send({ code: 200, submissionId: id, status: 'pending_manual', msg: "已提交，等待人工审核" });
              return;
            }
            db.run(
              'INSERT INTO verified_users (email, school_name, auth_type, auth_token, token_expires_at, nickname) VALUES (?, ?, ?, ?, ?, ?)',
              ['sid_' + id, schoolName, 'student_id', authToken, tokenExpiresAt, nick],
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

// 阿里云内容安全：使用 POP 签名调用图片同步检测。中国地域固定使用 green.cn-shanghai.aliyuncs.com
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
      console.warn('阿里云图片审核 HTTP', resp.status, result.message || result.msg || JSON.stringify(result).slice(0, 200));
      throw new Error(result.message || result.msg || 'Request failed');
    }
    if (result.code === 200 && result.data && result.data.results && result.data.results[0]) {
      const suggestion = (result.data.results[0].suggestion || 'review').toLowerCase();
      if (suggestion === 'pass') return 'pass';
      if (suggestion === 'block') return 'rejected';
    }
    if (result.code === 400 && (result.message || '').toLowerCase().includes('url')) {
      console.warn('阿里云图片审核仅支持 URL 传图，当前使用 base64 可能被拒，请配置 OSS 或使用人工审核');
    }
  } catch (e) {
    console.warn('阿里云图片审核调用失败，转人工:', e.message);
    throw e;
  }
  return 'review';
}

// 学生证认证状态轮询（人工通过后前端可拿到 token）
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

// 解析认证 token，返回 { email, school_name, auth_type, nickname } 或 null
// 使用 datetime() 包装保证 SQLite 正确比较 ISO 格式的 token_expires_at 与当前时间
function parseAuthToken(authToken) {
  return new Promise((resolve) => {
    const t = authToken != null ? String(authToken).trim() : '';
    if (!t) return resolve(null);
    db.get(
      'SELECT email, school_name, auth_type, nickname FROM verified_users WHERE auth_token = ? AND datetime(token_expires_at) > datetime("now")',
      [t],
      (err, row) => resolve(err ? null : row)
    );
  });
}

// 学生分享相关接口统一从请求中读取 token：body.authToken / body.auth_token → query.authToken → header X-Auth-Token / Authorization
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

// 获取当前认证用户信息（用于恢复学校等，解决认证后无法上传）
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

// 提交学生分享（需信息认证；在读生限认证学校，高考生不可带学校/专业）
// 若 token 无效但请求来自「分享你的经历」表单（fromShareForm），且含学校/标题/内容，则兜底允许发帖（解决创空间多实例/DB 不一致导致 token 查不到）
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

// 举报帖子（举报次数>50 进入后台审核）
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

// 帖子点赞/取消点赞（所有人：认证用户用 token，游客用 body/query 的 guestId）
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

// 获取某帖子的评论列表（一级评论 + 回复，仅 approved；带 token 时每条带 user_has_liked）
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
  db.run(`UPDATE share_comments SET status = 'deleted' WHERE delete_after IS NOT NULL AND datetime(delete_after) <= datetime('now')`, () => {});

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
     AND (delete_after IS NULL OR datetime(delete_after) > datetime('now'))
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

// 发表评论或回复（不校验 token，身份由前端页面认证区域决定：identity=guest 显示游客，identity=verified 用 nickname/school_name）
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

// 举报评论（举报次数≥50 进入后台审核）
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

// 评论点赞/取消点赞（所有人：认证用户用 token，游客用 guestId）
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

// ========== 学校相关 API ==========

// 获取所有学校列表（含 schools 表 + 仅在 school_programs 中出现的学校，便于按学校检索）
app.get('/api/schools', (req, res) => {
  const sql = `SELECT school_name, school_level, location FROM schools
               UNION
               SELECT school_name, school_level, location FROM school_programs WHERE school_name NOT IN (SELECT school_name FROM schools)
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

// 获取某学校的所有专业（从 school_programs 读取，与 AI/管理后台录入一致）
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
app.post('/admin/schools', verifyAdmin, (req, res) => {
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
app.post('/admin/school-programs', verifyAdmin, (req, res) => {
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

// ========== 数据录入用 AI（DeepSeek）==========

// 调用 DeepSeek（数据录入与邮箱后缀识别；429 时重试 2 次）
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

// 学生分享：DeepSeek 分析有用比率与情绪，并写回数据库（按编号锁定帖子）
const USEFULNESS_KEYWORDS = '学业、课程、保研、就业、面试、压力、位次、宿舍、食堂、生活、学习';
async function analyzeShareAndUpdate(shareId, title, content, tags) {
  if (!DEEPSEEK_API_KEY) return;
  const text = [title, content, tags].filter(Boolean).join('\n');
  const systemPrompt = `你是一个面向高考生的校园内容质量评估助手。请仅根据用户给出一段帖子文本，完成两项判断，并只输出一个 JSON 对象，不要其他说明或换行外的内容。

1) 有用比率 usefulness_ratio（0-100 的整数）：以句子为单位，根据以下「内容比率关键词」是否出现及出现频率，判断该帖对高考生了解校园生活或学习情况是否有用。关键词包括：${USEFULNESS_KEYWORDS}。综合整篇帖子，给出 0-100 的有用比率。

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
  db.run(
    `UPDATE student_shares SET usefulness_ratio = ?, is_emotional = ?, analyzed_at = datetime('now'), delete_after = ${shouldDelete ? "datetime('now', '+24 hours')" : 'NULL'} WHERE id = ?`,
    [usefulness_ratio, is_emotional, shareId],
    (err) => { if (err) console.error('UPDATE student_shares 分析结果失败:', err); }
  );
}

// 评论：DeepSeek 仅判断情绪过重，写回 is_emotional / delete_after
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
    `UPDATE share_comments SET is_emotional = ?, analyzed_at = datetime('now'), delete_after = ${shouldDelete ? "datetime('now', '+24 hours')" : 'NULL'} WHERE id = ?`,
    [is_emotional, commentId],
    (err) => { if (err) console.error('UPDATE share_comments 分析结果失败:', err); }
  );
}

// 数据录入用 AI（仅 DeepSeek，未配置时需设置 DEEPSEEK_API_KEY）
async function callDataEntryAI(prompt, systemPrompt = '') {
  if (!DEEPSEEK_API_KEY)
    throw new Error("DeepSeek 未配置，请设置 DEEPSEEK_API_KEY 后进行数据录入");
  return callDeepSeekAI(prompt, systemPrompt);
}

// 检查该专业下该院校是否已录入（避免重复）
function schoolProgramExists(majorId, schoolName) {
  return new Promise((resolve) => {
    db.get('SELECT id FROM school_programs WHERE major_id = ? AND school_name = ?', [majorId, schoolName], (err, row) => resolve(!!(row && !err)));
  });
}

// 确认该校是否开设该专业（必须基于学校官网，未检索到则视为未开设）
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

// 根据专业名获取或由 AI 自动创建专业；专业概况从阳光高考查，院校情况仅来自院校官网
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

// 管理员：使用AI检索并添加（专业不存在时自动创建；该专业下该院校已录入则跳过）
app.post('/admin/ai-add-program', verifyAdmin, async (req, res) => {
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
    db.run(`INSERT OR IGNORE INTO schools (school_name, school_level, location) VALUES (?, ?, ?)`, [sName, programData.school_level || '', programData.location || '']);
    res.send({ code: 200, msg: "AI检索并添加成功", id: majorId, data: programData });
  } catch (e) {
    console.error("AI添加失败:", e);
    res.send({ code: 500, msg: "AI检索失败: " + e.message });
  }
});

// 管理员：批量AI添加（专业不存在时自动创建并录入介绍、培养方案、课程、招生计划）
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
      db.run(`INSERT OR IGNORE INTO schools (school_name, school_level, location) VALUES (?, ?, ?)`, [name, programData.school_level || '', programData.location || '']);
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

// 管理员：仅提供学校名称，AI 自动检索并添加该校所有招生专业（专业自动创建并录入介绍、培养方案、课程、招生计划）
app.post('/admin/ai-add-school-all-majors', verifyAdmin, async (req, res) => {
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
        db.run(`INSERT OR IGNORE INTO schools (school_name, school_level, location) VALUES (?, ?, ?)`, [name, programData.school_level || '', programData.location || '']);
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
    res.send({ code: 500, msg: "检索失败: " + err.message });
  }
});

// ========== 专业动态新闻API ==========

// 获取新闻：支持 limit（默认6）、random=1 随机取、major_id 按专业筛选
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
    ? ` ORDER BY RANDOM() LIMIT ?`
    : ` ORDER BY is_hot DESC, publish_date DESC, id DESC LIMIT ?`;
  params.push(limit);
  db.all(sql, params, (err, rows) => {
    if (err) {
      console.error("获取新闻失败:", err);
      res.send({ code: 500, msg: "获取失败" });
      return;
    }
    res.send({ code: 200, data: rows || [] });
  });
});

// 获取单条新闻详情
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

// 启动服务，监听 0.0.0.0:7860
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ 服务已启动！地址：http://0.0.0.0:${PORT}`);
  console.log(`📊 数据目录: ${DATA_DIR}`);
  console.log(`🤖 智能查询（百炼应用）: ${BAILIAN_API_KEY && BAILIAN_APP_ID ? '已配置' : '未配置'}`);
  console.log(`🤖 DeepSeek（邮箱识别+数据录入）: ${DEEPSEEK_API_KEY ? '已配置' : '未配置'}`);
});

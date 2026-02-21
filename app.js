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

// AI API 配置 - 从环境变量读取 API Key
const AI_API_KEY = process.env.AI_KEY;
const AI_API_URL = process.env.AI_API_URL || 'http://116.62.36.98:3001/api/v1/workspace/project/chat';
const AI_MODEL = process.env.AI_MODEL || 'default';

// 豆包AI配置 - 用于数据管理和院校信息检索
const DOUBAO_API_KEY = process.env.DOUBAO_KEY || '04ab8a51-281f-499f-b2a6-7c3782bb30ca';
const DOUBAO_API_URL = process.env.DOUBAO_API_URL || 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';
const DOUBAO_MODEL = process.env.DOUBAO_MODEL || 'doubao-pro-32k';

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

    // 学生证认证：待审核/已通过/已拒绝（AI 或人工）
    db.run(`CREATE TABLE IF NOT EXISTS student_id_verifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      school_name TEXT NOT NULL,
      image_data TEXT,
      status TEXT NOT NULL DEFAULT 'pending_manual',
      auth_token TEXT,
      token_expires_at DATETIME,
      ali_task_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
      if (err) console.error("创建学生证认证表失败:", err);
      else console.log("✅ 学生证认证表初始化成功！");
    });

    // 帖子评论表（评论需认证）
    db.run(`CREATE TABLE IF NOT EXISTS share_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      share_id INTEGER NOT NULL,
      user_email TEXT NOT NULL,
      school_name TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (share_id) REFERENCES student_shares(id)
    )`, (err) => {
      if (err) console.error("创建评论表失败:", err);
      else console.log("✅ 评论表初始化成功！");
    });
    
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

// ********** 功能3：AI 查询 - 使用本地知识库回复 **********
app.post('/ai-query', async (req, res) => {
  const { prompt, profileSummary, shareEntries, isXuanke, xuankeContext } = req.body;
  
  try {
    // 构建上下文信息
    let contextInfo = "";
    if (profileSummary && profileSummary !== "（未填写）") {
      contextInfo += `\n用户基本信息：${profileSummary}`;
    }
    if (shareEntries && shareEntries.length > 0) {
      contextInfo += "\n在读学生分享信息：\n";
      shareEntries.slice(0, 5).forEach((entry, i) => {
        contextInfo += `[${i+1}] ${entry.school || ''} - ${entry.major || ''}: ${entry.experience || ''}\n`;
      });
    }
    if (isXuanke && xuankeContext) {
      const combo = [xuankeContext.first, ...xuankeContext.second].filter(Boolean).join("+");
      contextInfo += `\n选科信息：首选 ${xuankeContext.first || '未选'}，再选 ${xuankeContext.second?.join('、') || '未选'}（组合：${combo}）`;
      contextInfo += `\n省份：${xuankeContext.province || '未填'}`;
    }

    // 调用 AnythingLLM API
    try {
      const fetch = (await import('node-fetch')).default;
      console.log(`正在调用 AnythingLLM API: ${AI_API_URL}`);
      console.log(`API Key 是否配置: ${AI_API_KEY ? '已配置' : '未配置'}`);
      
      if (!AI_API_KEY) {
        console.error("AI_KEY 环境变量未设置");
        throw new Error("AI_KEY 未配置");
      }
      
      // 生成新的 sessionId，确保每次查询都是新对话
      const sessionId = `session_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      console.log(`使用新会话 ID: ${sessionId}`);
      
      const response = await fetch(AI_API_URL, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${AI_API_KEY}`
        },
        body: JSON.stringify({
          message: `${contextInfo}\n\n用户问题：${prompt}\n\n请给出详细、专业的回答：`,
          mode: "chat",
          sessionId: sessionId
        })
      });

      console.log(`API 响应状态: ${response.status}`);
      
      if (response.ok) {
        const result = await response.json();
        console.log("AnythingLLM API 调用成功，响应内容:", JSON.stringify(result).substring(0, 200));
        
        // 尝试多种可能的响应格式
        let aiResponse = result.textResponse || 
                        result.response || 
                        (result.choices && result.choices[0] && result.choices[0].message && result.choices[0].message.content) ||
                        result.content ||
                        result.message;
        
        if (aiResponse) {
          res.send({ 
            code: 200, 
            data: aiResponse
          });
          return;
        } else {
          console.error("API 返回成功但无法解析响应内容:", result);
          res.send({ code: 500, msg: "AI 响应格式错误，请联系管理员检查日志" });
          return;
        }
      } else {
        const errorText = await response.text();
        console.error(`AnythingLLM API 错误: ${response.status}`, errorText);
        res.send({ code: 500, msg: `AI 服务错误 (${response.status}): ${errorText}` });
        return;
      }
    } catch (aiError) {
      console.error("AnythingLLM API 调用失败:", aiError.message);
      res.send({ code: 500, msg: "AI 服务调用失败: " + aiError.message });
      return;
    }
    
  } catch (error) {
    console.error("AI 查询失败:", error);
    res.send({ code: 500, msg: "AI 查询失败: " + error.message });
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
  db.get('SELECT id, school_name, status FROM student_id_verifications WHERE id = ?', [id], (err, row) => {
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
    const tokenExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    db.run(
      'UPDATE student_id_verifications SET status = ?, auth_token = ?, token_expires_at = ? WHERE id = ?',
      ['approved', authToken, tokenExpiresAt, id],
      (e) => {
        if (e) {
          res.send({ code: 500, msg: "操作失败" });
          return;
        }
        db.run(
          'INSERT INTO verified_users (email, school_name, auth_type, auth_token, token_expires_at) VALUES (?, ?, ?, ?, ?)',
          ['sid_' + id, row.school_name, 'student_id', authToken, tokenExpiresAt],
          (e2) => {
            res.send(e2 ? { code: 500, msg: "通过成功但写入用户表失败" } : { code: 200, msg: "已通过", authToken });
          }
        );
      }
    );
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

// 获取学生分享列表（支持搜索）
app.get('/api/student-shares', (req, res) => {
  const { school, major, keyword } = req.query;
  let sql = `SELECT * FROM student_shares WHERE status = 'approved'`;
  const params = [];
  
  if (school) {
    sql += ` AND school = ?`;
    params.push(school);
  }
  
  if (major) {
    sql += ` AND major = ?`;
    params.push(major);
  }
  
  if (keyword) {
    sql += ` AND (title LIKE ? OR content LIKE ? OR tags LIKE ?)`;
    params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
  }
  
  sql += ` ORDER BY upload_time DESC`;
  
  db.all(sql, params, (err, rows) => {
    if (err) {
      console.error("获取学生分享失败:", err);
      res.send({ code: 500, msg: "获取失败" });
      return;
    }
    res.send({ code: 200, data: rows });
  });
});

// 学生分享图片存储分隔符（data URL 内含逗号，不可用逗号分隔）
const IMAGE_SEP = '|||IMAGE_SEP|||';

// ========== 信息认证（学校邮箱验证） ==========

// 豆包：根据邮箱后缀识别学校名称
async function getSchoolFromEmailSuffix(emailSuffix) {
  const prompt = `请根据中国高校邮箱后缀判断对应的学校中文名称。例如：pku.edu.cn -> 北京大学；tsinghua.edu.cn -> 清华大学；fudan.edu.cn -> 复旦大学。
邮箱后缀：${emailSuffix}
只返回学校的中文全称，不要任何标点、解释或换行。如果无法确定，返回"未知"`;
  try {
    const result = await callDoubaoAI(prompt, '你是一个教育数据助手。根据邮箱后缀准确识别中国大陆高校中文名称。');
    return (result || '').trim().replace(/["'\n\r。，、]/g, '') || '未知';
  } catch (e) {
    console.error("豆包识别学校失败:", e);
    return '未知';
  }
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

// 验证码校验，获得认证
app.post('/api/auth/verify', (req, res) => {
  const { email, code } = req.body;
  const emailLower = (email || '').trim().toLowerCase();
  const codeStr = String(code || '').trim();

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
      const tokenExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

      db.run(
        'INSERT OR REPLACE INTO verified_users (email, school_name, auth_type, auth_token, token_expires_at) VALUES (?, ?, ?, ?, ?)',
        [emailLower, schoolName, 'email', authToken, tokenExpiresAt],
        function (replaceErr) {
          if (replaceErr) {
            res.send({ code: 500, msg: "认证失败" });
            return;
          }
          res.send({
            code: 200,
            msg: "认证成功",
            authToken,
            school: schoolName,
            expiresAt: tokenExpiresAt
          });
        }
      );
    }
  );
});

// 阿里云内容安全配置（可选，用于学生证鉴伪）
const ALIYUN_ACCESS_KEY_ID = process.env.ALIYUN_ACCESS_KEY_ID;
const ALIYUN_ACCESS_KEY_SECRET = process.env.ALIYUN_ACCESS_KEY_SECRET;
const ALIYUN_GREEN_REGION = process.env.ALIYUN_GREEN_REGION || 'cn-shanghai';

// 学生证认证：提交图片，先走阿里云鉴伪（若已配置），存疑则 pending_manual 等人审
app.post('/api/auth/student-id', async (req, res) => {
  const { school, imageBase64 } = req.body;
  const schoolName = (school || '').trim();
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
  if (ALIYUN_ACCESS_KEY_ID && ALIYUN_ACCESS_KEY_SECRET) {
    try {
      const result = await callAliyunImageScan(rawBase64);
      if (result === 'pass') status = 'approved';
      else if (result === 'rejected') status = 'rejected';
      else status = 'pending_manual';
    } catch (e) {
      console.error("阿里云图片鉴伪失败，转人工:", e.message);
      status = 'pending_manual';
    }
  }

  db.run(
    'INSERT INTO student_id_verifications (school_name, image_data, status) VALUES (?, ?, ?)',
    [schoolName, rawBase64, status],
    function (err) {
      if (err) {
        res.send({ code: 500, msg: "提交失败" });
        return;
      }
      const id = this.lastID;
      if (status === 'approved') {
        const authToken = require('crypto').randomBytes(32).toString('hex');
        const tokenExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
        db.run(
          'UPDATE student_id_verifications SET auth_token = ?, token_expires_at = ? WHERE id = ?',
          [authToken, tokenExpiresAt, id],
          (updateErr) => {
            if (updateErr) {
              res.send({ code: 200, submissionId: id, status: 'pending_manual', msg: "已提交，等待人工审核" });
              return;
            }
            db.run(
              'INSERT INTO verified_users (email, school_name, auth_type, auth_token, token_expires_at) VALUES (?, ?, ?, ?, ?)',
              ['sid_' + id, schoolName, 'student_id', authToken, tokenExpiresAt],
              () => {
                res.send({ code: 200, msg: "认证成功", authToken, school: schoolName, submissionId: id });
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

// 阿里云图片鉴伪：翻拍/PS 检测。官方接口需 OpenAPI 签名且多接受图片 URL；未配置或调用失败时一律转人工审核
async function callAliyunImageScan(imageBase64) {
  const fetch = (await import('node-fetch')).default;
  const endpoint = `green-cip.${ALIYUN_GREEN_REGION}.aliyuncs.com`;
  const path = '/green/image/scan';
  const body = JSON.stringify({
    bizType: 'student_id_check',
    scenes: ['recapDetector', 'psDetector'],
    tasks: [{ dataId: require('crypto').randomUUID(), imageBytes: imageBase64 }]
  });
  try {
    const resp = await fetch(`https://${endpoint}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    });
    const result = await resp.json().catch(() => ({}));
    if (resp.ok && result.code === 200 && result.data && result.data.results && result.data.results[0]) {
      const suggestion = (result.data.results[0].suggestion || 'review').toLowerCase();
      if (suggestion === 'pass') return 'pass';
      if (suggestion === 'block') return 'rejected';
    }
  } catch (e) {
    console.warn('阿里云鉴伪调用失败，转人工:', e.message);
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
    'SELECT status, auth_token, token_expires_at, school_name FROM student_id_verifications WHERE id = ?',
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
        school: row.school_name
      });
    }
  );
});

// 解析认证 token，返回 { email, school } 或 null
function parseAuthToken(authToken) {
  return new Promise((resolve) => {
    if (!authToken) return resolve(null);
    db.get(
      'SELECT email, school_name FROM verified_users WHERE auth_token = ? AND token_expires_at > datetime("now")',
      [String(authToken).trim()],
      (err, row) => resolve(err ? null : row)
    );
  });
}

// 提交学生分享（需信息认证，只能在认证学校下发帖）
app.post('/api/student-shares', async (req, res) => {
  const { school, major, grade, title, content, tags, images, authToken } = req.body;
  const token = authToken || req.headers['x-auth-token'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '');

  const verified = await parseAuthToken(token);
  if (!verified) {
    res.send({ code: 403, msg: "请先完成信息认证（学校邮箱验证）" });
    return;
  }
  if (!school || !major || !title || !content) {
    res.send({ code: 400, msg: "学校、专业、标题和内容为必填项" });
    return;
  }
  if (school !== verified.school_name) {
    res.send({ code: 403, msg: `您只能在认证学校「${verified.school_name}」下发帖` });
    return;
  }

  const imagesStr = images && Array.isArray(images) ? images.join(IMAGE_SEP) : '';
  const sql = `INSERT INTO student_shares (school, major, grade, title, content, tags, images, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'approved')`;
  db.run(sql, [school, major, grade || '未知年级', title, content, tags || '', imagesStr], function (err) {
    if (err) {
      console.error("保存学生分享失败:", err);
      res.send({ code: 500, msg: "保存失败" });
      return;
    }
    res.send({ code: 200, msg: "分享提交成功！", id: this.lastID });
  });
});

// 获取帖子评论
app.get('/api/student-shares/:id/comments', (req, res) => {
  const shareId = req.params.id;
  db.all('SELECT id, share_id, user_email, school_name, content, created_at FROM share_comments WHERE share_id = ? ORDER BY created_at ASC', [shareId], (err, rows) => {
    if (err) {
      res.send({ code: 500, msg: "获取评论失败" });
      return;
    }
    res.send({ code: 200, data: rows });
  });
});

// 发表评论（需信息认证）
app.post('/api/student-shares/:id/comments', async (req, res) => {
  const shareId = req.params.id;
  const { content, authToken } = req.body;
  const token = authToken || req.headers['x-auth-token'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '');

  const verified = await parseAuthToken(token);
  if (!verified) {
    res.send({ code: 403, msg: "请先完成信息认证（学校邮箱验证）" });
    return;
  }
  const contentTrimmed = (content || '').trim();
  if (!contentTrimmed) {
    res.send({ code: 400, msg: "请输入评论内容" });
    return;
  }

  db.run(
    'INSERT INTO share_comments (share_id, user_email, school_name, content) VALUES (?, ?, ?, ?)',
    [shareId, verified.email, verified.school_name, contentTrimmed],
    function (err) {
      if (err) {
        res.send({ code: 500, msg: "评论失败" });
        return;
      }
      res.send({ code: 200, msg: "评论成功", id: this.lastID });
    }
  );
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

// ========== 豆包AI数据管理功能 ==========

// 调用豆包AI进行院校信息检索和整理
async function callDoubaoAI(prompt, systemPrompt = '') {
  try {
    const fetch = (await import('node-fetch')).default;
    
    if (!DOUBAO_API_KEY) {
      console.error("DOUBAO_KEY 环境变量未设置");
      throw new Error("豆包AI密钥未配置");
    }
    
    const response = await fetch(DOUBAO_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DOUBAO_API_KEY}`
      },
      body: JSON.stringify({
        model: DOUBAO_MODEL,
        messages: [
          {
            role: 'system',
            content: systemPrompt || '你是一个专业的教育数据管理助手，擅长整理和分析高校及专业信息。请根据用户提供的院校或专业名称，从官方网站检索相关信息并以结构化JSON格式返回。'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.7,
        max_tokens: 4000
      })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`豆包AI API错误: ${response.status}`, errorText);
      throw new Error(`API错误: ${response.status}`);
    }
    
    const result = await response.json();
    return result.choices?.[0]?.message?.content || '';
  } catch (error) {
    console.error("调用豆包AI失败:", error);
    throw error;
  }
}

// 检查该专业下该院校是否已录入（避免重复）
function schoolProgramExists(majorId, schoolName) {
  return new Promise((resolve) => {
    db.get('SELECT id FROM school_programs WHERE major_id = ? AND school_name = ?', [majorId, schoolName], (err, row) => resolve(!!(row && !err)));
  });
}

// 根据专业名获取或由 AI 自动创建专业；专业概况从阳光高考查，院校情况从院校官网查
async function getOrCreateMajorAndProgramData(majorName, schoolName) {
  const existing = await new Promise((resolve) => {
    db.get('SELECT id FROM major_overviews WHERE major_name = ?', [majorName], (err, row) => resolve(err ? null : row));
  });
  if (existing) {
    const prompt = `请从「${schoolName}」官方网站（院校官网）检索「${majorName}」专业在该校的开设信息，以JSON格式返回：
{"school_level":"院校层次","location":"所在城市","program_features":"培养特色（200字以内）","courses":"主要课程，逗号分隔","course_intros":[{"name":"课程名","intro":"课程基本介绍（50-100字）"}，可多项，无介绍则intro为空字符串],"admission_requirements":"招生要求","tuition_fee":"学费","scholarships":"奖学金","contact_info":"招生办联系方式"}`;
    const aiResponse = await callDoubaoAI(prompt);
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
2）该校该专业的开设情况（院校层次、所在城市、培养特色、课程、招生要求、学费、奖学金、联系方式）请从「${schoolName}」官方网站（院校官网）查询。
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
  const aiResponse = await callDoubaoAI(fullPrompt);
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
    const listResponse = await callDoubaoAI(listPrompt, '你只输出一个 JSON 数组，不要 markdown 代码块包裹。');
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

// 获取所有新闻
app.get('/api/news', (req, res) => {
  const sql = `SELECT * FROM major_news ORDER BY is_hot DESC, publish_date DESC`;
  db.all(sql, [], (err, rows) => {
    if (err) {
      console.error("获取新闻失败:", err);
      res.send({ code: 500, msg: "获取失败" });
      return;
    }
    res.send({ code: 200, data: rows });
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
  console.log(`🤖 AI配置: ${AI_API_KEY ? '已配置' : '未配置'}`);
  console.log(`🤖 豆包AI: ${DOUBAO_API_KEY ? '已配置' : '未配置'}`);
});

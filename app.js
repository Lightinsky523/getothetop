const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const app = express();

// 从环境变量读取配置
const PORT = process.env.PORT || 7860;
const DATA_DIR = process.env.DATA_DIR || '/home/user/app/data';

// AI API 配置 - 从环境变量读取 API Key
const AI_API_KEY = process.env.AI_KEY;
const AI_API_URL = process.env.AI_API_URL || 'http://116.62.36.98:3001/api/v1/workspace/project/chat';
const AI_MODEL = process.env.AI_MODEL || 'default';

// 豆包AI配置 - 用于数据管理和院校信息检索
const DOUBAO_API_KEY = process.env.DOUBAO_KEY;
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
// 解析网页提交的信息
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 提供静态文件服务（前端页面）
app.use(express.static(path.join(__dirname)));

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
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`, (err) => {
  if (err) {
    console.error("创建专业概览表失败:", err);
  } else {
    console.log("✅ 专业概览表初始化成功！");
  }
});

// 创建开设院校表
db.run(`CREATE TABLE IF NOT EXISTS school_programs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  major_id INTEGER,
  school_name TEXT NOT NULL,
  school_level TEXT,
  location TEXT,
  program_features TEXT,
  courses TEXT,
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
  
  const sql = `INSERT INTO school_programs (major_id, school_name, school_level, location, program_features, courses, admission_requirements, tuition_fee, scholarships, contact_info) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  db.run(sql, [major_id, school_name, school_level, location, program_features, courses, admission_requirements, tuition_fee, scholarships, contact_info], function(err) {
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

// 公开API：按专业搜索
app.get('/api/majors/search', (req, res) => {
  const { keyword } = req.query;
  const sql = `SELECT * FROM major_overviews WHERE major_name LIKE ? OR category LIKE ? ORDER BY major_name`;
  db.all(sql, [`%${keyword}%`, `%${keyword}%`], (err, rows) => {
    if (err) {
      console.error("搜索专业失败:", err);
      res.send({ code: 500, msg: "搜索失败" });
      return;
    }
    res.send({ code: 200, data: rows });
  });
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

// 提交学生分享（带图片）
app.post('/api/student-shares', (req, res) => {
  const { school, major, grade, title, content, tags, images } = req.body;
  
  if (!school || !major || !title || !content) {
    res.send({ code: 400, msg: "学校、专业、标题和内容为必填项" });
    return;
  }
  
  // 将图片数组转为逗号分隔的字符串
  const imagesStr = images && Array.isArray(images) ? images.join(',') : '';
  
  const sql = `INSERT INTO student_shares (school, major, grade, title, content, tags, images, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'approved')`;
  db.run(sql, [school, major, grade || '未知年级', title, content, tags || '', imagesStr], function(err) {
    if (err) {
      console.error("保存学生分享失败:", err);
      res.send({ code: 500, msg: "保存失败" });
      return;
    }
    res.send({ code: 200, msg: "分享提交成功！", id: this.lastID });
  });
});

// ========== 学校相关 API ==========

// 获取所有学校列表
app.get('/api/schools', (req, res) => {
  const sql = `SELECT * FROM schools ORDER BY school_name`;
  db.all(sql, [], (err, rows) => {
    if (err) {
      console.error("获取学校列表失败:", err);
      res.send({ code: 500, msg: "获取失败" });
      return;
    }
    res.send({ code: 200, data: rows });
  });
});

// 获取某学校的所有专业
app.get('/api/schools/:schoolName/majors', (req, res) => {
  const schoolName = req.params.schoolName;
  const sql = `SELECT smp.*, mo.id as major_id, mo.major_name, mo.category, mo.degree_type 
               FROM school_major_programs smp 
               LEFT JOIN major_overviews mo ON smp.major_id = mo.id 
               WHERE smp.school_name = ?`;
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

// 管理员：使用AI从院校官网检索并添加专业信息
app.post('/admin/ai-add-program', verifyAdmin, async (req, res) => {
  const { password, school_name, major_name, major_id } = req.body;
  
  if (!school_name || !major_name) {
    res.send({ code: 400, msg: "学校名称和专业名称为必填项" });
    return;
  }
  
  try {
    // 构建AI提示词，要求从院校官网检索信息
    const prompt = `请从${school_name}官方网站检索${major_name}专业的详细信息，并以JSON格式返回以下信息：
{
  "school_level": "院校层次（如：985、211、双一流等）",
  "location": "院校所在城市",
  "program_features": "该专业在该校的培养特色（200字以内）",
  "courses": "主要课程，用逗号分隔",
  "stream_division": "大类分流方案（如有）",
  "admission_requirements": "招生要求",
  "tuition_fee": "学费信息",
  "scholarships": "奖学金信息",
  "contact_info": "招生办联系方式"
}

请确保信息准确，如无法获取某项信息，对应字段返回空字符串。`;

    const aiResponse = await callDoubaoAI(prompt);
    
    // 解析AI返回的JSON
    let programData;
    try {
      // 尝试从AI响应中提取JSON
      const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        programData = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error("无法解析AI返回的数据");
      }
    } catch (parseErr) {
      console.error("解析AI返回数据失败:", parseErr);
      res.send({ code: 500, msg: "AI返回数据解析失败，请手动添加" });
      return;
    }
    
    // 插入数据库
    const sql = `INSERT INTO school_major_programs 
      (school_name, major_id, major_name, program_features, courses, stream_division, 
       admission_requirements, tuition_fee, scholarships, contact_info) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    
    db.run(sql, [
      school_name,
      major_id || null,
      major_name,
      programData.program_features || '',
      programData.courses || '',
      programData.stream_division || '',
      programData.admission_requirements || '',
      programData.tuition_fee || '',
      programData.scholarships || '',
      programData.contact_info || ''
    ], function(err) {
      if (err) {
        console.error("添加专业项目失败:", err);
        res.send({ code: 500, msg: "添加失败: " + err.message });
        return;
      }
      
      // 同时添加学校信息（如果不存在）
      const schoolSql = `INSERT OR IGNORE INTO schools (school_name, school_level, location) VALUES (?, ?, ?)`;
      db.run(schoolSql, [school_name, programData.school_level || '', programData.location || '']);
      
      res.send({ 
        code: 200, 
        msg: "AI检索并添加成功", 
        id: this.lastID,
        data: programData
      });
    });
    
  } catch (err) {
    console.error("AI添加失败:", err);
    res.send({ code: 500, msg: "AI检索失败: " + err.message });
  }
});

// 管理员：批量AI添加多个专业
app.post('/admin/ai-batch-add', verifyAdmin, async (req, res) => {
  const { password, school_name, majors } = req.body;
  
  if (!school_name || !majors || !Array.isArray(majors)) {
    res.send({ code: 400, msg: "参数错误" });
    return;
  }
  
  const results = [];
  const errors = [];
  
  for (const major of majors) {
    try {
      const prompt = `请从${school_name}官方网站检索${major}专业的核心信息，以JSON格式返回：
{
  "program_features": "培养特色（150字以内）",
  "courses": "主要课程，逗号分隔",
  "tuition_fee": "学费"
}`;

      const aiResponse = await callDoubaoAI(prompt);
      const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
      
      if (jsonMatch) {
        const data = JSON.parse(jsonMatch[0]);
        
        await new Promise((resolve, reject) => {
          const sql = `INSERT INTO school_major_programs 
            (school_name, major_name, program_features, courses, tuition_fee) 
            VALUES (?, ?, ?, ?, ?)`;
          db.run(sql, [school_name, major, data.program_features || '', data.courses || '', data.tuition_fee || ''], 
            function(err) {
              if (err) reject(err);
              else resolve(this.lastID);
            }
          );
        });
        
        results.push({ major, status: 'success' });
      }
    } catch (err) {
      errors.push({ major, error: err.message });
    }
  }
  
  res.send({
    code: 200,
    msg: `批量添加完成，成功${results.length}个，失败${errors.length}个`,
    results,
    errors
  });
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

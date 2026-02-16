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
      status TEXT DEFAULT 'pending',
      upload_time DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
      if (err) {
        console.error("创建学生分享表失败：", err);
      } else {
        console.log("✅ 学生分享表初始化成功！");
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

// 启动服务，监听 0.0.0.0:7860
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ 服务已启动！地址：http://0.0.0.0:${PORT}`);
});

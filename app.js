const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const app = express();

// 从环境变量读取配置
const PORT = process.env.PORT || 7860;
const DATA_DIR = process.env.DATA_DIR || '/home/user/app/data';

// Ollama 公网配置
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://116.62.36.98:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:0.5b';

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
    // 创建表（如果不存在）
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
        console.error("创建表失败：", err);
      } else {
        console.log("✅ 数据表初始化成功！");
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

    // 调用阿里云 Ollama API
    try {
      const fetch = (await import('node-fetch')).default;
      console.log(`正在调用 Ollama: ${OLLAMA_HOST}/api/generate`);
      
      const response = await fetch(`${OLLAMA_HOST}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: OLLAMA_MODEL,
          prompt: `你是一位专业的高考志愿填报顾问。

${contextInfo}

用户问题：${prompt}

请给出详细、专业的回答：`,
          stream: false
        })
      });

      if (response.ok) {
        const result = await response.json();
        console.log("Ollama 调用成功");
        res.send({ 
          code: 200, 
          data: result.response || "AI 未能生成回复"
        });
        return;
      } else {
        console.error(`Ollama API 错误: ${response.status}`);
      }
    } catch (ollamaError) {
      console.error("Ollama 调用失败:", ollamaError.message);
    }

    // 如果 Ollama 不可用，使用本地模拟回复
    const mockResponse = generateMockResponse(prompt, profileSummary, shareEntries, isXuanke, xuankeContext);
    res.send({ code: 200, data: mockResponse });
    
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

// 启动服务，监听 0.0.0.0:7860
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ 服务已启动！地址：http://0.0.0.0:${PORT}`);
});

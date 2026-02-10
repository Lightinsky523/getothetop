const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const path = require('path');
const app = express();

// 从环境变量读取配置
const MYSQL_HOST = process.env.MYSQL_HOST || 'localhost';
const MYSQL_USER = process.env.MYSQL_USER || 'root';
const MYSQL_PASSWORD = process.env.MYSQL_PASSWORD || '';
const MYSQL_DB = process.env.MYSQL_DB || 'study_experience';
const MYSQL_PORT = process.env.MYSQL_PORT || 3306;
const PORT = process.env.PORT || 7860;

// AnythingLLM API 配置
const ANYTHINGLLM_API_KEY = process.env.ANYTHINGLLM_API_KEY || '';
const ANYTHINGLLM_BASE_URL = process.env.ANYTHINGLLM_BASE_URL || 'http://localhost:3001';

// 允许网页跨域访问
app.use(cors());
// 解析网页提交的信息
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 提供静态文件服务（前端页面）
app.use(express.static(path.join(__dirname)));

// 连接MySQL数据库
const db = mysql.createConnection({
  host: MYSQL_HOST,
  user: MYSQL_USER,
  password: MYSQL_PASSWORD,
  database: MYSQL_DB,
  port: MYSQL_PORT,
  charset: 'utf8mb4'
});

// 测试数据库连接
db.connect((err) => {
  if (err) {
    console.log("数据库连接失败：", err);
    return;
  }
  console.log("✅ 数据库连接成功！");
});

// ********** 功能1：接收网页提交的用户信息，存到MySQL **********
app.post('/save-data', (req, res) => {
  const { school, major, city, gaokao_year, experience, label } = req.body;
  const sql = `INSERT INTO user_uploads (school, major, city, gaokao_year, experience, label) VALUES (?, ?, ?, ?, ?, ?)`;
  db.query(sql, [school, major, city, gaokao_year, experience, label], (err, result) => {
    if (err) {
      console.error("存数据失败:", err);
      res.send({ code: 500, msg: "存数据失败" });
      return;
    }
    res.send({ code: 200, msg: "存数据成功！" });
  });
});

// ********** 功能2：从MySQL取数据，返回给网页展示 **********
app.get('/get-data', (req, res) => {
  const sql = `SELECT * FROM user_uploads ORDER BY upload_time DESC`;
  db.query(sql, (err, data) => {
    if (err) {
      console.error("取数据失败:", err);
      res.send({ code: 500, msg: "取数据失败" });
      return;
    }
    res.send({ code: 200, data: data });
  });
});

// ********** 功能3：AI 查询 - 调用 AnythingLLM API **********
app.post('/ai-query', async (req, res) => {
  const { prompt, profileSummary, shareEntries, isXuanke, xuankeContext } = req.body;
  
  if (!ANYTHINGLLM_API_KEY) {
    res.send({ code: 500, msg: "AI 服务未配置" });
    return;
  }

  try {
    // 构建系统提示词
    let systemPrompt = "你是一位专业的高考志愿填报顾问。请根据用户的问题和提供的信息，给出专业、详细的建议。";
    
    // 添加上下文信息
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

    const fullPrompt = `${systemPrompt}
${contextInfo}

用户问题：${prompt}

请给出详细、专业的回答，包括具体的建议和分析。`;

    // 调用 AnythingLLM API
    const fetch = (await import('node-fetch')).default;
    const response = await fetch(`${ANYTHINGLLM_BASE_URL}/api/v1/workspace/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ANYTHINGLLM_API_KEY}`
      },
      body: JSON.stringify({
        message: fullPrompt,
        mode: 'chat'
      })
    });

    if (!response.ok) {
      throw new Error(`API 请求失败: ${response.status}`);
    }

    const result = await response.json();
    res.send({ 
      code: 200, 
      data: result.textResponse || result.response || "AI 未能生成回复"
    });
  } catch (error) {
    console.error("AI 查询失败:", error);
    res.send({ code: 500, msg: "AI 查询失败: " + error.message });
  }
});

// 启动服务，监听 0.0.0.0:7860
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ 服务已启动！地址：http://0.0.0.0:${PORT}`);
});

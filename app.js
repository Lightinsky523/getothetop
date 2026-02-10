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

// 启动服务，监听 0.0.0.0:7860
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ 服务已启动！地址：http://0.0.0.0:${PORT}`);
});

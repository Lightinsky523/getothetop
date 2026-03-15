/**
 * ============================
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const mysql = require('mysql2/promise');
const nodemailer = require('nodemailer');

console.log("文件开始执行");

const app = express();
const PORT = process.env.PORT || 7860;

console.log("解析数据目录...");
function resolveDataDir() {
  console.log("进入 resolveDataDir");
  if (process.env.VERCEL) return '/tmp';
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  if (process.env.DATASET_MOUNT_PATH) return process.env.DATASET_MOUNT_PATH;
  const persistDir = process.env.DATASET_LOCAL_PATH || '/home/user/app/Data_for_GAS';
  if (!fs.existsSync(persistDir)) {
    fs.mkdirSync(persistDir, { recursive: true });
  }
  console.log("数据目录解析完成", persistDir);
  return persistDir;
}

const DATA_DIR = resolveDataDir();

const MYSQL_HOST = process.env.MYSQL_HOST || '115.29.233.160';
const MYSQL_PORT = parseInt(process.env.MYSQL_PORT || '3306', 10);
const MYSQL_USER = process.env.MYSQL_USER;
const MYSQL_PASSWORD = process.env.MYSQL_PASSWORD;
const MYSQL_DATABASE = process.env.MYSQL_DATABASE || 'guidance_app';
let mysqlPool = null;

async function initMySQLForKeywords() {
  console.log("开始初始化 MySQL");
  if (mysqlPool) return mysqlPool;
  try {
    if (!MYSQL_USER || !MYSQL_PASSWORD) {
      throw new Error('缺少 MySQL 用户名或密码');
    }
    const baseConfig = { host: MYSQL_HOST, port: MYSQL_PORT, user: MYSQL_USER, password: MYSQL_PASSWORD };
    console.log("尝试连接 MySQL", MYSQL_HOST, MYSQL_PORT, MYSQL_USER);
    const connection = await mysql.createConnection(baseConfig);
    console.log("MySQL 连接成功");
    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${MYSQL_DATABASE}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    console.log("数据库确保存在", MYSQL_DATABASE);
    await connection.end();

    mysqlPool = mysql.createPool({ ...baseConfig, database: MYSQL_DATABASE, waitForConnections: true, connectionLimit: 10, charset: 'utf8mb4_general_ci' });
    console.log("MySQL pool 创建成功");
  } catch (e) {
    console.error("MySQL 初始化失败:", e.message);
    mysqlPool = null;
  }
  return mysqlPool;
}

console.log("准备启动服务...");
app.get('/', (req, res) => res.send("ok"));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ 服务已启动！端口 ${PORT}`);
});

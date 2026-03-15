// app.js 顶部
console.log("文件开始执行");  // ✅ 确认文件加载

// 数据目录解析
console.log("解析数据目录...");
const DATA_DIR = resolveDataDir();
console.log("DATA_DIR =", DATA_DIR);

// MySQL 初始化函数
async function initMySQLForKeywords() {
  console.log("开始初始化 MySQL");  // ✅ 确认进入初始化
  if (mysqlPool) return mysqlPool;

  try {
    if (!MYSQL_USER || !MYSQL_PASSWORD) {
      throw new Error('缺少 MySQL 用户名或密码，请通过环境变量 MYSQL_USER / MYSQL_PASSWORD 配置');
    }

    const baseConfig = { host: MYSQL_HOST, port: MYSQL_PORT, user: MYSQL_USER, password: MYSQL_PASSWORD };
    console.log("尝试连接 MySQL:", MYSQL_HOST, MYSQL_PORT, MYSQL_USER);

    const connection = await mysql.createConnection(baseConfig);
    console.log("MySQL 连接成功");

    // 确保数据库存在
    await connection.query(
      `CREATE DATABASE IF NOT EXISTS \`${MYSQL_DATABASE}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    console.log("数据库确保存在:", MYSQL_DATABASE);

    await connection.end();
    console.log("MySQL 初始连接关闭");

    // 创建连接池
    mysqlPool = mysql.createPool({
      ...baseConfig,
      database: MYSQL_DATABASE,
      waitForConnections: true,
      connectionLimit: 10,
      charset: 'utf8mb4_general_ci'
    });

    console.log("MySQL pool 创建成功");
  } catch (e) {
    console.error("MySQL 初始化失败:", e.message);
    mysqlPool = null;
  }

  return mysqlPool;
}

// 你的原有初始化逻辑，保持不变，只在关键位置加 log
console.log("开始执行原有初始化逻辑...");

// 例如调用 initMySQLForKeywords
initMySQLForKeywords().then(() => {
  console.log("MySQL 初始化完成，继续其他逻辑");

  // 这里可以加上原来的 db.run / table 初始化
  console.log("开始数据库表初始化...");
  // db.run(...) 等等

  console.log("数据库表初始化完成");

  // 最重要：在 listen 前加 log
  console.log("准备启动服务...");
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ 服务已启动！端口 ${PORT}`);
  });
});
/**
 * 管理员认证中间件
 */

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 12) {
  console.error('❌ ADMIN_PASSWORD 未设置或太短（至少12位），请通过环境变量配置');
  process.exit(1);
}

const ADMIN_TOKEN_EXPIRE = 24 * 60 * 60 * 1000;
const adminTokens = new Map();

// 清理过期 token
setInterval(() => {
  const now = Date.now();
  for (const [token, data] of adminTokens) {
    if (data.expiresAt < now) adminTokens.delete(token);
  }
}, 60 * 60 * 1000);

function verifyAdminToken(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  const tokenData = adminTokens.get(token);
  if (!tokenData || tokenData.expiresAt < Date.now()) {
    return res.status(401).json({ code: 401, msg: '登录已过期，请重新登录' });
  }
  req.adminPassword = tokenData.password;
  next();
}

function verifyAdmin(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  const tokenData = adminTokens.get(token);
  if (tokenData && tokenData.expiresAt >= Date.now()) {
    req.adminPassword = tokenData.password;
    return next();
  }
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) {
    return res.status(403).json({ code: 403, msg: '密码错误，无权限访问' });
  }
  req.adminPassword = password;
  next();
}

function checkAdminAuth(req) {
  const token = req.headers['x-admin-token'] || req.query.token;
  const tokenData = adminTokens.get(token);
  if (tokenData && tokenData.expiresAt >= Date.now()) {
    return tokenData.password;
  }
  const pwd = req.query.password || (req.body && req.body.password);
  if (pwd === ADMIN_PASSWORD) {
    return pwd;
  }
  return null;
}

function loginAdmin(password) {
  if (password !== ADMIN_PASSWORD) return null;
  const token = require('crypto').randomBytes(32).toString('hex');
  adminTokens.set(token, { password, expiresAt: Date.now() + ADMIN_TOKEN_EXPIRE });
  return token;
}

function logoutAdmin(token) {
  if (token) adminTokens.delete(token);
}

module.exports = { verifyAdminToken, verifyAdmin, checkAdminAuth, loginAdmin, logoutAdmin };

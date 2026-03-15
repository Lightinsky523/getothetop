/**
 * Vercel Serverless：将 /api/* 请求交给 Express 处理，使用 Vercel 环境变量（如 DEEPSEEK_API_KEY）。
 * 前端 /ai-query、/admin/* 经 vercel.json 重写到 /api/ai-query、/api/admin/* 后进入此处。
 */
const app = require('../app.js');

module.exports = (req, res) => {
  // Express 里 /ai-query 未挂在 /api 下，需把 /api/ai-query 转成 /ai-query
  if (req.url && req.url.startsWith('/api/ai-query')) {
    req.url = req.url.replace(/^\/api\/ai-query/, '/ai-query') || '/ai-query';
  }
  app(req, res);
};

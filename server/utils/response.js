/**
 * 统一响应格式与工具函数
 */

function success(res, data, msg = 'OK') {
  res.json({ code: 200, msg, data });
}

function fail(res, code, msg, status = 400) {
  res.status(status).json({ code, msg });
}

function sendError(res, err, status = 500) {
  const message = (err && err.message) || String(err) || '服务器内部错误';
  console.error('[Error]', message);
  res.status(status).json({ code: status, msg: message });
}

module.exports = { success, fail, sendError };

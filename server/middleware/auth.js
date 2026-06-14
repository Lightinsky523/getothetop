/**
 * 认证中间件与工具
 */

const { db } = require('../config/db');
const TOKEN_EXPIRY_MS = 10 * 365 * 24 * 60 * 60 * 1000;

function parseAuthToken(authToken) {
  return new Promise((resolve) => {
    const t = authToken != null ? String(authToken).trim() : '';
    if (!t) return resolve(null);
    db.get(
      'SELECT email, school_name, auth_type, nickname FROM verified_users WHERE auth_token = ? AND token_expires_at > NOW()',
      [t],
      (err, row) => resolve(err ? null : row)
    );
  });
}

function getTokenFromRequest(req) {
  const body = req.body || {};
  let token = (body.authToken != null ? String(body.authToken).trim() : '') || (body.auth_token != null ? String(body.auth_token).trim() : '');
  if (!token && req.query && req.query.authToken != null) token = String(req.query.authToken).trim();
  if (!token) {
    const raw = req.headers['x-auth-token'] || req.headers['authorization'];
    token = (raw && String(raw).trim()) || '';
    if (token && token.toLowerCase().startsWith('bearer ')) token = token.slice(7).trim();
  }
  return (token || '').trim();
}

module.exports = { parseAuthToken, getTokenFromRequest, TOKEN_EXPIRY_MS };

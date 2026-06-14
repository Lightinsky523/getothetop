/**
 * 认证路由：邮箱验证码 + 学生证认证
 */

const express = require('express');
const router = express.Router();
const { db, toMySQLDateTime, initMySQLForKeywords } = require('../config/db');
const { parseAuthToken, TOKEN_EXPIRY_MS } = require('../middleware/auth');
const { sendVerifyEmail, transporter } = require('../services/email');
const { getSchoolFromEmailSuffix } = require('../services/school');
const { callBailianVisionStudentId } = require('../services/bailian');
const BAILIAN_API_KEY = process.env.BAILIAN_API_KEY || process.env.DIRECT_AI_KEY;

// GET 后端配置检查
router.get('/backend-config', (req, res) => {
  res.json({
    code: 200,
    smtpConfigured: !!transporter,
    bailianConfigured: !!BAILIAN_API_KEY,
    stepfunConfigured: !!process.env.STEPFUN_API_KEY,
    msg: 'OK'
  });
});

// POST 发送验证码
router.post('/send-code', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  if (!email) {
    return res.json({ code: 400, msg: '请输入学校邮箱' });
  }
  const suffix = email.split('@')[1] || '';
  if (!suffix.endsWith('.edu') && !suffix.endsWith('.edu.cn')) {
    return res.json({ code: 400, msg: '请使用学校邮箱（以 .edu 或 .edu.cn 结尾）' });
  }
  const emailMasked = email.replace(/(.{3})(.*)(@.*)/, '$1***$3');

  try {
    await initMySQLForKeywords();
  } catch (mysqlErr) {
    console.error('[邮件] MySQL 未就绪:', mysqlErr.message);
    return res.json({ code: 503, msg: '服务暂不可用，请稍后重试' });
  }

  const schoolName = await getSchoolFromEmailSuffix(suffix);
  const code = String(Math.floor(100000 + Math.random() * 900000));
  try {
    const mysqlPool = require('../config/db').mysqlPool();
    await mysqlPool.execute(
      'INSERT INTO verification_codes (email, code, school_name, expires_at) VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 5 MINUTE))',
      [email, code, schoolName]
    );
  } catch (err) {
    console.error('保存验证码失败:', err);
    return res.json({ code: 500, msg: '发送失败' });
  }

  console.log('[邮件] 正在发送验证码至', emailMasked, '学校:', schoolName);
  const mailResult = await sendVerifyEmail(email, code);
  if (mailResult.success) {
    return res.json({ code: 200, msg: '验证码已发送到您的邮箱', school: schoolName });
  }
  if (mailResult.testMode) {
    return res.json({ code: 200, msg: '当前为测试模式，验证码已记录到服务器日志', school: schoolName });
  }
  const msg = (mailResult.error && mailResult.error.message) || mailResult.msg || '邮件发送失败';
  const codeNum = mailResult.error && (mailResult.error.responseCode || mailResult.error.code);
  let userMsg = '邮件发送失败，请稍后重试';
  if (codeNum === 535 || /authentication|auth|login|535/i.test(String(msg))) {
    userMsg = 'SMTP 认证失败，请检查 SMTP 授权码（163 邮箱需使用「授权码」而非登录密码）';
  } else if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND/i.test(String(msg))) {
    userMsg = '无法连接邮件服务器，请检查 SMTP 地址与端口';
  } else if (/recipient|550|553/i.test(String(msg))) {
    userMsg = '收件地址被拒绝，请确认邮箱正确';
  }
  res.json({ code: 500, msg: userMsg });
});

// POST 验证码校验
router.post('/verify', (req, res) => {
  const { email, code, nickname } = req.body;
  const emailLower = (email || '').trim().toLowerCase();
  const codeStr = String(code || '').trim();
  const nick = (nickname || '').trim() || '在读生';

  if (!emailLower || !codeStr) {
    return res.json({ code: 400, msg: '请输入邮箱和验证码' });
  }

  db.get(
    'SELECT school_name FROM verification_codes WHERE email = ? AND code = ? AND expires_at > NOW() ORDER BY id DESC LIMIT 1',
    [emailLower, codeStr],
    (err, row) => {
      if (err || !row) {
        return res.json({ code: 400, msg: '验证码错误或已过期' });
      }
      const schoolName = row.school_name || '未知';
      const authToken = require('crypto').randomBytes(32).toString('hex');
      const tokenExpiresAt = new Date(Date.now() + TOKEN_EXPIRY_MS).toISOString();

      db.run(
        'REPLACE INTO verified_users (email, school_name, auth_type, auth_token, token_expires_at, nickname) VALUES (?, ?, ?, ?, ?, ?)',
        [emailLower, schoolName, 'email', authToken, toMySQLDateTime(tokenExpiresAt), nick],
        (replaceErr) => {
          if (replaceErr) {
            return res.json({ code: 500, msg: '认证失败' });
          }
          res.json({
            code: 200, msg: '认证成功',
            authToken, school: schoolName, nickname: nick, expiresAt: tokenExpiresAt
          });
        }
      );
    }
  );
});

// POST 学生证认证
router.post('/student-id', async (req, res) => {
  const { school, imageBase64, nickname } = req.body;
  const schoolName = (school || '').trim();
  const nick = (nickname || '').trim() || '在读生';
  console.log('[学生证] 认证请求 received, school=', schoolName, 'imageSize=', (imageBase64 && imageBase64.length) || 0);
  if (!schoolName) {
    return res.json({ code: 400, msg: '请选择学校' });
  }
  const rawBase64 = (imageBase64 || '').replace(/^data:image\/\w+;base64,/, '');
  if (!rawBase64) {
    return res.json({ code: 400, msg: '请上传学生证图片' });
  }

  const MAX_RAW_BASE64_FOR_AI = 4 * 1024 * 1024;
  const manualDueToSize = rawBase64.length > MAX_RAW_BASE64_FOR_AI;

  let status = 'pending_manual';
  if (!manualDueToSize) {
    try {
      const aiResult = await callBailianVisionStudentId(rawBase64);
      console.log('[学生证] 百炼鉴伪结果:', aiResult);
      if (aiResult === 'pass') status = 'approved';
      else status = 'pending_manual';
    } catch (e) {
      console.error('[学生证] AI 鉴伪异常，转人工:', e.message);
    }
  }
  console.log('[学生证] 最终状态:', status);

  db.run(
    'INSERT INTO student_id_verifications (school_name, image_data, status, nickname) VALUES (?, ?, ?, ?)',
    [schoolName, rawBase64, status, nick],
    function (err) {
      if (err) {
        return res.json({ code: 500, msg: '提交失败' });
      }
      const id = this.lastID;
      if (status === 'approved') {
        const authToken = require('crypto').randomBytes(32).toString('hex');
        const tokenExpiresAt = new Date(Date.now() + TOKEN_EXPIRY_MS).toISOString();
        db.run(
          'UPDATE student_id_verifications SET auth_token = ?, token_expires_at = ? WHERE id = ?',
          [authToken, toMySQLDateTime(tokenExpiresAt), id],
          (updateErr) => {
            if (updateErr) {
              return res.json({ code: 200, submissionId: id, status: 'pending_manual', msg: '已提交，等待人工审核' });
            }
            db.run(
              'INSERT INTO verified_users (email, school_name, auth_type, auth_token, token_expires_at, nickname) VALUES (?, ?, ?, ?, ?, ?)',
              ['sid_' + id, schoolName, 'student_id', authToken, toMySQLDateTime(tokenExpiresAt), nick],
              () => {
                res.json({ code: 200, msg: '认证成功', authToken, school: schoolName, nickname: nick, submissionId: id });
              }
            );
          }
        );
      } else {
        const msg = manualDueToSize
          ? '图片过大，无法送检百炼鉴伪，将提交后台人工审核。'
          : '已提交，等待人工审核';
        res.json({ code: 200, submissionId: id, status: 'pending_manual', msg });
      }
    }
  );
});

// GET 学生证认证状态轮询
router.get('/student-id/status', (req, res) => {
  const submissionId = req.query.submissionId;
  if (!submissionId) {
    return res.json({ code: 400, msg: '缺少 submissionId' });
  }
  db.get(
    'SELECT status, auth_token, token_expires_at, school_name, nickname FROM student_id_verifications WHERE id = ?',
    [submissionId],
    (err, row) => {
      if (err || !row) {
        return res.json({ code: 404, msg: '记录不存在' });
      }
      const expired = row.token_expires_at && new Date(row.token_expires_at) < new Date();
      res.json({
        code: 200,
        status: row.status,
        authToken: row.status === 'approved' && !expired ? row.auth_token : undefined,
        school: row.school_name,
        nickname: row.nickname || undefined
      });
    }
  );
});

// GET 当前登录用户信息
router.get('/me', async (req, res) => {
  const token = require('../middleware/auth').getTokenFromRequest(req);
  const verified = await parseAuthToken(token || null);
  if (!verified) {
    return res.json({ code: 403, msg: '未登录或已过期' });
  }
  res.json({
    code: 200,
    school: verified.school_name,
    nickname: verified.nickname,
    authType: verified.auth_type
  });
});

module.exports = router;

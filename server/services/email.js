/**
 * 邮件服务：SMTP 配置与验证码发送
 */

const nodemailer = require('nodemailer');

let transporter = null;

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_PORT = parseInt(process.env.SMTP_PORT, 10) || 465;
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER || '';

if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
  const smtpHost = SMTP_HOST.trim();
  const smtpUser = SMTP_USER.trim();
  const smtpPass = SMTP_PASS.trim();
  console.log('===== SMTP配置信息 =====');
  console.log('SMTP服务器:', smtpHost);
  console.log('SMTP端口:', SMTP_PORT);
  console.log('发件人邮箱:', smtpUser);
  console.log('=========================');

  try {
    transporter = nodemailer.createTransport({
      host: smtpHost,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: { user: smtpUser, pass: smtpPass },
      requireTLS: SMTP_PORT === 587,
      tls: {
        rejectUnauthorized: false,
        minVersion: 'TLSv1.2',
        maxVersion: 'TLSv1.3',
        servername: smtpHost
      },
      connectionTimeout: 30 * 1000,
      greetingTimeout: 30 * 1000,
      socketTimeout: 60 * 1000,
      debug: true,
      logger: true
    });

    transporter.verify((error, success) => {
      if (error) {
        console.error('❌ SMTP连接失败:', error);
        transporter = null;
      } else {
        console.log('✅ SMTP邮件服务连接成功');
      }
    });
  } catch (e) {
    console.error('❌ SMTP客户端初始化异常:', e);
    transporter = null;
  }
}

async function sendVerifyEmail(toEmail, code) {
  if (!transporter) {
    const testMsg = `⚠️ SMTP服务不可用，进入测试模式，收件人：${toEmail}，验证码：${code}`;
    console.warn(testMsg);
    return { success: false, testMode: true, code, msg: testMsg };
  }
  try {
    const sendResult = await transporter.sendMail({
      from: `"志愿填报系统" <${SMTP_FROM || SMTP_USER}>`,
      to: toEmail,
      subject: '【志愿填报系统】邮箱认证验证码',
      text: `您的验证码是：${code}，有效期10分钟，请勿泄露给他人。`,
      html: `您的验证码是：<b style="font-size: 20px; color: #165DFF;">${code}</b>，有效期10分钟，请勿泄露给他人。`
    });
    console.log('✅ 邮件发送成功，收件人：', toEmail, '发送结果：', sendResult);
    return { success: true, msg: '邮件发送成功' };
  } catch (sendError) {
    console.error('❌ 邮件发送失败:', toEmail, sendError);
    return { success: false, error: sendError, msg: '邮件发送失败' };
  }
}

module.exports = { sendVerifyEmail, transporter, SMTP_HOST, SMTP_USER, SMTP_PASS };

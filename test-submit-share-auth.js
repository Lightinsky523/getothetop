#!/usr/bin/env node
/**
 * 模拟试验：验证「提交分享」时仅通过 URL 传 authToken 是否被服务端正确识别。
 * 使用方式：先在本机运行 npm start 启动服务，再在项目目录执行 node test-submit-share-auth.js
 */

const BASE = 'http://127.0.0.1:7860';

async function run() {
  console.log('1. 使用高考生认证获取 token...');
  const authRes = await fetch(BASE + '/api/auth/gaokao', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname: '模拟测试用户' })
  });
  const authData = await authRes.json().catch(() => ({}));
  if (!authData.authToken) {
    console.error('认证失败:', authData.msg || authRes.status);
    process.exit(1);
  }
  const token = authData.authToken;
  console.log('   已获得 token (前8位):', token.slice(0, 8) + '...');

  console.log('\n2. 模拟提交分享：仅把 token 放在 URL 上（不放在 Header 和 Body）...');
  const urlWithToken = BASE + '/api/student-shares?authToken=' + encodeURIComponent(token);
  const submitRes = await fetch(urlWithToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      school: '某大学',
      major: '某专业',
      grade: '大一',
      title: '测试标题',
      content: '测试内容',
      tags: '',
      images: []
      // 故意不传 authToken，验证服务端是否从 URL 读取
    })
  });
  const submitData = await submitRes.json().catch(() => ({}));

  if (submitData.code === 403 && (submitData.msg || '').includes('高考生仅可评论')) {
    console.log('   结果: 403 - 高考生仅可评论，不可发帖');
    console.log('\n✅ 说明：服务端从 URL 的 authToken 正确识别了身份（高考生），没有出现「请先完成信息认证」。');
    console.log('   若 token 未被识别，会返回「请先完成信息认证」。');
    return;
  }
  if (submitData.code === 403 && (submitData.msg || '').includes('请先完成信息认证')) {
    console.log('   结果: 403 - 请先完成信息认证');
    console.log('\n❌ 服务端未从 URL 读取到 token，请检查 app.js 中 POST /api/student-shares 的 token 读取顺序。');
    process.exit(1);
  }
  console.log('   响应:', submitData.code, submitData.msg || submitData);
  process.exit(1);
}

run().catch((e) => {
  console.error('请求失败（请先运行 npm start 启动服务）:', e.message);
  process.exit(1);
});

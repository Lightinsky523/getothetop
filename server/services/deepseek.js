/**
 * DeepSeek 服务：对话 + 数据录入
 */

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_KEY;
const DEEPSEEK_API_URL = process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/v1/chat/completions';
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

async function callDeepSeekAI(prompt, systemPrompt = '', retryCount = 0) {
  const fetch = (await import('node-fetch')).default;
  if (!DEEPSEEK_API_KEY) {
    throw new Error('DeepSeek 密钥未配置（请设置 DEEPSEEK_API_KEY）');
  }
  const body = {
    model: DEEPSEEK_MODEL,
    messages: [
      {
        role: 'system',
        content: systemPrompt || '你是一个专业的教育数据管理助手，擅长整理和分析高校及专业信息。请根据用户提供的院校或专业名称，从官方网站检索相关信息并以结构化JSON格式返回。'
      },
      { role: 'user', content: prompt }
    ],
    temperature: 0.7,
    max_tokens: 4000
  };
  const response = await fetch(DEEPSEEK_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
    },
    body: JSON.stringify(body)
  });
  if (response.status === 429 && retryCount < 2) {
    const waitMs = 5000 + retryCount * 3000;
    console.warn(`DeepSeek API 429，${waitMs / 1000}秒后重试 (${retryCount + 1}/2)`);
    await new Promise((r) => setTimeout(r, waitMs));
    return callDeepSeekAI(prompt, systemPrompt, retryCount + 1);
  }
  if (!response.ok) {
    const errorText = await response.text();
    console.error(`DeepSeek API 错误: ${response.status}`, errorText.slice(0, 300));
    if (response.status === 429) throw new Error('DeepSeek 请求过于频繁(429)，请稍后再试');
    throw new Error(`DeepSeek API 错误: ${response.status}`);
  }
  const result = await response.json();
  return result.choices?.[0]?.message?.content || '';
}

async function callDataEntryAI(prompt, systemPrompt = '') {
  if (!DEEPSEEK_API_KEY) {
    throw new Error('DeepSeek 未配置，请设置 DEEPSEEK_API_KEY 后进行数据录入');
  }
  return callDeepSeekAI(prompt, systemPrompt);
}

function extractJson(raw) {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (_) { return null; }
}

function extractJsonArray(raw) {
  const m = raw.match(/\[[\s\S]*\]/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (_) { return null; }
}

module.exports = {
  callDeepSeekAI,
  callDataEntryAI,
  extractJson,
  extractJsonArray,
  DEEPSEEK_API_KEY
};

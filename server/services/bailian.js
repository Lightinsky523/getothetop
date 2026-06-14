/**
 * Bailian（阿里云百炼）服务：内容审核 + 学生证鉴伪
 */

const BAILIAN_API_KEY = process.env.BAILIAN_API_KEY || process.env.DIRECT_AI_KEY;
const DASHSCOPE_VISION_MODEL = process.env.DASHSCOPE_VISION_MODEL || 'qwen-vl-plus';
const DASHSCOPE_BASE = 'https://dashscope.aliyuncs.com';

async function callBailianVisionStudentId(imageBase64) {
  if (!BAILIAN_API_KEY) {
    console.warn('[学生证鉴伪] 未配置 BAILIAN_API_KEY，直接转人工审核');
    return 'review';
  }
  const fetch = (await import('node-fetch')).default;
  const imageUrl = imageBase64.startsWith('data:') ? imageBase64 : `data:image/jpeg;base64,${imageBase64}`;
  try {
    const response = await fetch(`${DASHSCOPE_BASE}/compatible-mode/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${BAILIAN_API_KEY}`
      },
      body: JSON.stringify({
        model: DASHSCOPE_VISION_MODEL,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: '请判断这张图片是否为真实的学生证/校园卡照片（含学校名称、个人信息等）。仅回答一个字：是 或 否。' },
              { type: 'image_url', image_url: { url: imageUrl } }
            ]
          }
        ],
        max_tokens: 50
      })
    });
    const rawBody = await response.text();
    if (!response.ok) {
      console.warn('[学生证鉴伪] 百炼视觉 API 非 200:', response.status, rawBody.slice(0, 400));
      return 'review';
    }
    let result;
    try { result = JSON.parse(rawBody); } catch (e) { return 'review'; }
    const text = (result.choices?.[0]?.message?.content || result.output?.text || result.output?.choices?.[0]?.message?.content || '').trim();
    console.log('[学生证鉴伪] 百炼返回原文:', JSON.stringify(text).slice(0, 200));
    if (/^是|真实|有效|学生证|确认为?真/.test(text) && !/否|不真实|假|非学生证/.test(text)) return 'pass';
    if (/是/.test(text) && !/否|不真实|假|非学生证/.test(text)) return 'pass';
    if (/yes|true|real/.test(text.toLowerCase()) && !/no|false|假|非学生证|不真实/.test(text)) return 'pass';
    return 'review';
  } catch (e) {
    console.error('[学生证鉴伪] 请求异常:', e.message);
    return 'review';
  }
}

async function callBailianTextModeration(title, content, tags) {
  if (!BAILIAN_API_KEY) return 'review';
  const fetch = (await import('node-fetch')).default;
  const text = [title, content, tags].filter(Boolean).join('\n').slice(0, 3000);
  if (!text.trim()) return 'pass';
  try {
    const response = await fetch(`${DASHSCOPE_BASE}/compatible-mode/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${BAILIAN_API_KEY}`
      },
      body: JSON.stringify({
        model: 'qwen-turbo',
        messages: [
          {
            role: 'system',
            content: '你是一个内容安全审核助手。仅根据规则判断用户输入是否违规。违规包括：色情低俗、暴力恐怖、违法信息、人身攻击、恶意广告、违禁品等。仅回答 exactly 以下之一：通过、违规、无法判断。不要解释。'
          },
          {
            role: 'user',
            content: `请判断以下内容是否违规：\n${text}`
          }
        ],
        max_tokens: 20
      })
    });
    if (!response.ok) return 'review';
    const result = await response.json();
    const answer = (result.choices?.[0]?.message?.content || result.output?.text || '').trim();
    if (/通过|合规|正常/.test(answer) && !/违规|不通过/.test(answer)) return 'pass';
    if (/违规|不通过|违禁|拒绝/.test(answer)) return 'block';
  } catch (e) {
    console.error('百炼文本审核失败:', e.message);
  }
  return 'review';
}

module.exports = { callBailianVisionStudentId, callBailianTextModeration, BAILIAN_API_KEY };

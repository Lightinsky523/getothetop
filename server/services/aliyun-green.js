/**
 * 阿里云内容安全（可选）
 */

const ALIYUN_ACCESS_KEY_ID = process.env.ALIYUN_ACCESS_KEY_ID || process.env.ALIBABA_CLOUD_ACCESS_KEY_ID;
const ALIYUN_ACCESS_KEY_SECRET = process.env.ALIYUN_ACCESS_KEY_SECRET || process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET;
const ALIYUN_GREEN_REGION = process.env.ALIYUN_GREEN_REGION || 'cn-shanghai';

function signAliyunGreen(method, path, body, headers, accessKeySecret) {
  const crypto = require('crypto');
  const contentMd5 = body ? crypto.createHash('md5').update(body, 'utf8').digest('base64') : '';
  const stringToSign = [
    method, 'application/json', contentMd5, 'application/json',
    headers['Date'],
    Object.keys(headers)
      .filter((k) => k.toLowerCase().startsWith('x-acs-'))
      .sort()
      .map((k) => k + ':' + headers[k])
      .join('\n'),
    path
  ].join('\n');
  const signature = crypto.createHmac('sha1', accessKeySecret + '&').update(stringToSign, 'utf8').digest('base64');
  return signature;
}

async function callAliyunImageScan(imageBase64) {
  console.log('[阿里云] 开始调用内容安全图片鉴伪接口');
  const fetch = (await import('node-fetch')).default;
  const crypto = require('crypto');
  const endpoint = 'green.cn-shanghai.aliyuncs.com';
  const clientInfoStr = JSON.stringify({ userId: 'student_id_check' });
  const pathForSign = '/green/image/scan?clientInfo=' + clientInfoStr;
  const body = JSON.stringify({
    bizType: 'student_id_check',
    scenes: ['porn', 'terrorism'],
    tasks: [{ dataId: crypto.randomUUID(), imageBytes: imageBase64 }]
  });
  const date = new Date().toUTCString();
  const nonce = crypto.randomUUID();
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Date': date,
    'x-acs-version': '2018-05-09',
    'x-acs-signature-nonce': nonce,
    'x-acs-signature-version': '1.0',
    'x-acs-signature-method': 'HMAC-SHA1'
  };
  const contentMd5 = crypto.createHash('md5').update(body, 'utf8').digest('base64');
  headers['Content-MD5'] = contentMd5;
  const signature = signAliyunGreen('POST', pathForSign, body, headers, ALIYUN_ACCESS_KEY_SECRET);
  headers['Authorization'] = 'acs ' + ALIYUN_ACCESS_KEY_ID + ':' + signature;

  try {
    const url = 'https://' + endpoint + '/green/image/scan?clientInfo=' + encodeURIComponent(clientInfoStr);
    const resp = await fetch(url, { method: 'POST', headers, body });
    const result = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      console.warn('[阿里云] 图片审核 HTTP', resp.status, result.message || result.msg || JSON.stringify(result).slice(0, 200));
      throw new Error(result.message || result.msg || 'Request failed');
    }
    if (result.code === 200 && result.data && result.data.results && result.data.results[0]) {
      const suggestion = (result.data.results[0].suggestion || 'review').toLowerCase();
      console.log('[阿里云] 鉴伪接口调用完成，suggestion:', suggestion);
      if (suggestion === 'pass') return 'pass';
      if (suggestion === 'block') return 'rejected';
    }
  } catch (e) {
    console.warn('[阿里云] 图片审核调用失败，转人工:', e.message);
    throw e;
  }
  return 'review';
}

module.exports = { callAliyunImageScan, ALIYUN_ACCESS_KEY_ID, ALIYUN_ACCESS_KEY_SECRET };

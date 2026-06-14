/**
 * 学校识别服务：邮箱后缀 → 学校名
 */

const { callDeepSeekAI } = require('./deepseek');

const EMAIL_SUFFIX_TO_SCHOOL = {
  'pku.edu.cn': '北京大学',
  'tsinghua.edu.cn': '清华大学',
  'fudan.edu.cn': '复旦大学',
  'sjtu.edu.cn': '上海交通大学',
  'zju.edu.cn': '浙江大学',
  'nju.edu.cn': '南京大学',
  'ustc.edu.cn': '中国科学技术大学',
  'whu.edu.cn': '武汉大学',
  'nankai.edu.cn': '南开大学',
  'ruc.edu.cn': '中国人民大学',
  'tongji.edu.cn': '同济大学',
  'xmu.edu.cn': '厦门大学',
  'sysu.edu.cn': '中山大学',
  'scu.edu.cn': '四川大学',
  'hit.edu.cn': '哈尔滨工业大学',
  'buaa.edu.cn': '北京航空航天大学',
  'bupt.edu.cn': '北京邮电大学',
  'bit.edu.cn': '北京理工大学',
  'njupt.edu.cn': '南京邮电大学',
  'seu.edu.cn': '东南大学'
};

async function getSchoolFromEmailSuffix(emailSuffix) {
  const suffixLower = (emailSuffix || '').trim().toLowerCase();
  if (suffixLower && EMAIL_SUFFIX_TO_SCHOOL[suffixLower])
    return EMAIL_SUFFIX_TO_SCHOOL[suffixLower];

  const { DEEPSEEK_API_KEY } = require('./deepseek');
  if (!DEEPSEEK_API_KEY)
    return EMAIL_SUFFIX_TO_SCHOOL[suffixLower] || '未知';

  const prompt = `请根据中国高校邮箱后缀判断对应的学校中文名称。例如：pku.edu.cn -> 北京大学；tsinghua.edu.cn -> 清华大学；fudan.edu.cn -> 复旦大学。
邮箱后缀：${emailSuffix}
只返回学校的中文全称，不要任何标点、解释或换行。如果无法确定，返回"未知"`;
  const systemPrompt = '你是一个教育数据助手。根据邮箱后缀准确识别中国大陆高校中文名称。';
  try {
    const result = await callDeepSeekAI(prompt, systemPrompt);
    let name = (result || '').trim();
    const firstLine = name.split(/\n/)[0].trim();
    const afterColon = (firstLine.includes('：') ? firstLine.split('：').pop() : firstLine) || (firstLine.includes(':') ? firstLine.split(':').pop() : firstLine);
    name = (afterColon || firstLine).trim().replace(/^["']|["']$/g, '').replace(/[\n\r]/g, '').replace(/[。，、]+$/g, '').trim();
    if (name && name !== '未知') return name;
  } catch (e) {
    console.error('邮箱后缀识别学校失败:', e);
  }
  return EMAIL_SUFFIX_TO_SCHOOL[suffixLower] || '未知';
}

module.exports = { getSchoolFromEmailSuffix, EMAIL_SUFFIX_TO_SCHOOL };

const express = require('express');
const router = express.Router();
const crypto = require('crypto');

const { db, mysqlPool: getMysqlPool, toMySQLDateTime, toTinyInt, loadKeywordCategories } = require('../config/db');
const { parseAuthToken, getTokenFromRequest, TOKEN_EXPIRY_MS } = require('../middleware/auth');
const { callBailianTextModeration } = require('../services/bailian');
const { callDeepSeekAI, DEEPSEEK_API_KEY } = require('../services/deepseek');

// 学生分享：有用度低于此阈值视为无用；新帖宽限期（分钟）内不因分析结果被过滤
const SHARE_USEFULNESS_THRESHOLD = 30;
const SHARE_GRACE_MINUTES = 15;

// 与列表接口一致：已通过、未到删除时间，且（新帖宽限期内 或 有用度达标且非情绪化）
const SHARE_LIST_WHERE = `s.status = 'approved'
  AND (s.delete_after IS NULL OR s.delete_after > NOW())
  AND ( s.upload_time >= DATE_SUB(NOW(), INTERVAL ${SHARE_GRACE_MINUTES} MINUTE)
    OR ( (s.usefulness_ratio IS NULL OR s.usefulness_ratio >= ${SHARE_USEFULNESS_THRESHOLD}) AND (s.is_emotional IS NULL OR s.is_emotional = 0) ) )`;

// 多张图片存一个字段时用此分隔符（因为 base64 里本身有逗号）
const IMAGE_SEP = '|||IMAGE_SEP|||';

// 举报阈值
const REPORT_THRESHOLD = 50;

/**
 * 从用户问题里检测是否提到具体学校名（从学生分享表里出现的学校名匹配）
 * 返回 { school, keyword } 或 null，用于决定按“某校+关键词”还是按“关键词”取帖
 */
function getSchoolFromPrompt(prompt) {
  return new Promise((resolve) => {
    db.all(
      `SELECT DISTINCT s.school FROM student_shares s WHERE ${SHARE_LIST_WHERE.replace(/s\./g, 's.')} AND s.school IS NOT NULL AND TRIM(s.school) != ''`,
      [],
      (err, rows) => {
        if (err || !rows || rows.length === 0) return resolve(null);
        const p = (prompt || '').trim();
        const sorted = rows.map((r) => (r.school || '').trim()).filter(Boolean).sort((a, b) => b.length - a.length);
        for (const school of sorted) {
          if (school && p.includes(school)) {
            const keyword = p.replace(school, '').replace(/[？?]\s*$/, '').trim();
            return resolve({ school, keyword: keyword.length >= 1 ? keyword : '' });
          }
        }
        resolve(null);
      }
    );
  });
}

/** 按学校（及可选关键词）取点赞数最高的最多 limit 条帖子，供智能查询总结用 */
function fetchTopSharesBySchool(schoolName, keyword, limit = 100) {
  return new Promise((resolve) => {
    let sql = `SELECT s.id, s.school, s.major, s.title, s.content, s.tags, s.author_nickname, s.upload_time,
      COUNT(sl.share_id) AS like_count
      FROM student_shares s
      LEFT JOIN share_likes sl ON sl.share_id = s.id
      WHERE ${SHARE_LIST_WHERE} AND s.school = ?`;
    const params = [schoolName];
    if (keyword && keyword.trim()) {
      const k = '%' + keyword.trim() + '%';
      sql += ` AND (s.title LIKE ? OR s.content LIKE ? OR s.tags LIKE ?)`;
      params.push(k, k, k);
    }
    sql += ` GROUP BY s.id ORDER BY like_count DESC LIMIT ?`;
    params.push(String(limit));
    db.all(sql, params, (err, rows) => {
      if (err) return resolve([]);
      resolve(rows || []);
    });
  });
}

/** 从用户输入里用空格/标点拆出关键词（至少 2 个字），用于按热度取帖 */
function extractKeywords(prompt) {
  return (prompt || '')
    .replace(/[,，、；;!\s]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2);
}

/** 按关键词匹配取点赞数最高的最多 limit 条；没关键词就取全局热度前 limit 条 */
function fetchTopSharesByKeyword(prompt, limit = 100) {
  return new Promise((resolve) => {
    const keywords = extractKeywords(prompt);
    const baseSql = `SELECT s.id, s.school, s.major, s.title, s.content, s.tags, s.author_nickname, s.upload_time,
      COUNT(sl.share_id) AS like_count
      FROM student_shares s
      LEFT JOIN share_likes sl ON sl.share_id = s.id
      WHERE ${SHARE_LIST_WHERE}`;
    if (keywords.length === 0) {
      db.all(baseSql + ` GROUP BY s.id ORDER BY like_count DESC LIMIT ?`, [String(limit)], (err, rows) => {
        if (err) return resolve([]);
        resolve(rows || []);
      });
      return;
    }
    const conditions = keywords.map(() => '(s.title LIKE ? OR s.content LIKE ? OR s.tags LIKE ? OR s.school LIKE ? OR s.major LIKE ?)').join(' OR ');
    const params = keywords.flatMap((k) => {
      const p = '%' + k + '%';
      return [p, p, p, p, p];
    });
    params.push(String(limit));
    db.all(baseSql + ` AND (${conditions}) GROUP BY s.id ORDER BY like_count DESC LIMIT ?`, params, (err, rows) => {
      if (err) return resolve([]);
      resolve(rows || []);
    });
  });
}

/**
 * 根据用户输入从学生分享里筛出相关帖子（关键词匹配），限制条数避免 AI 超时
 * 与列表规则一致：排除无用、情绪化、已到删除时间的帖子
 */
function fetchRelevantShares(prompt, limit = 10) {
  return new Promise((resolve) => {
    const where = `status = 'approved'
      AND (delete_after IS NULL OR delete_after > NOW())
      AND ( upload_time >= DATE_SUB(NOW(), INTERVAL ${SHARE_GRACE_MINUTES} MINUTE)
        OR ( (usefulness_ratio IS NULL OR usefulness_ratio >= ${SHARE_USEFULNESS_THRESHOLD}) AND (is_emotional IS NULL OR is_emotional = 0) ) )`;
    db.all(
      `SELECT id, school, major, grade, title, content, tags, author_nickname, upload_time FROM student_shares WHERE ${where} ORDER BY upload_time DESC LIMIT 80`,
      [],
      (err, rows) => {
        if (err || !rows || rows.length === 0) {
          return resolve([]);
        }
        const keywords = (prompt || '')
          .replace(/[,，、；;!\s]+/g, ' ')
          .split(/\s+/)
          .filter((w) => w.length >= 2);
        if (keywords.length === 0) {
          return resolve(rows.slice(0, limit));
        }
        const lower = (s) => (s || '').toLowerCase();
        const matched = rows.filter((row) => {
          const text = [row.school, row.major, row.title, row.content, row.tags].map(lower).join(' ');
          return keywords.some((k) => text.includes(lower(k)));
        });
        resolve((matched.length ? matched : rows).slice(0, limit));
      }
    );
  });
}

// 点赞时识别用户：认证用户用 token，游客用 guestId（body 或 query）
function getLikeUserIdentity(req) {
  const token = getTokenFromRequest(req);
  const body = req.body || {};
  const query = req.query || {};
  const guestId = (body.guestId != null ? body.guestId : query.guestId) != null ? String(body.guestId || query.guestId).trim() : '';
  return { token, guestId };
}

/** 统计文本中各个“类型词”的出现次数，并根据占比生成自动标签 */
function analyzeCategoryDistribution(text, keywordCategoriesMap) {
  const result = [];
  const plain = (text || '').toString();
  if (!plain.trim()) return { total: 0, stats: [], autoTags: [] };

  let totalCount = 0;
  for (const [category, keywords] of Object.entries(keywordCategoriesMap || {})) {
    let count = 0;
    for (const kw of keywords) {
      if (!kw) continue;
      const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(escaped, 'g');
      const matches = plain.match(re);
      if (matches) count += matches.length;
    }
    if (count > 0) {
      result.push({ category, count });
      totalCount += count;
    }
  }

  if (!totalCount) return { total: 0, stats: [], autoTags: [] };

  result.sort((a, b) => b.count - a.count);
  const autoTags = [];
  result.forEach((item, index) => {
    const ratio = item.count / totalCount;
    if (ratio >= 0.2 || (index === 0 && ratio >= 0.15) || index < 2) {
      autoTags.push(item.category);
    }
  });
  return { total: totalCount, stats: result, autoTags };
}

/** 学生分享发布后异步调用：DeepSeek 分析有用度 usefulness_ratio 和是否情绪过重，写回 DB；若无用或情绪化则设 delete_after 为 24h 后；同时根据 MySQL 中的类型词占比自动打标签（可在前端继续编辑） */
async function analyzeShareAndUpdate(shareId, title, content, tags) {
  if (!DEEPSEEK_API_KEY) return;
  const text = [title, content, tags].filter(Boolean).join('\n');

  // 从 MySQL 中读取「类型词」与分类，用于提示 AI 判断有用度，同时本地计算各分类占比
  const keywordCategoriesMap = await loadKeywordCategories();
  const keywordCategoryDesc = Object.entries(keywordCategoriesMap || {})
    .map(([cat, kws]) => `${cat}：${kws.join('、')}`)
    .join('；');

  const systemPrompt = `你是一个面向高考生的校园内容质量评估助手。请仅根据用户给出一段帖子文本，完成两项判断，并只输出一个 JSON 对象，不要其他说明或换行外的内容。

1) 有用比率 usefulness_ratio（0-100 的整数）：以句子为单位，根据以下「内容比率关键词」是否出现及出现频率，判断该帖对高考生了解校园生活或学习情况是否有用。不同类型及其关键词如下（每类里的词语在数据库中维护，这里只是当前快照）：
${keywordCategoryDesc}
综合整篇帖子，给出 0-100 的有用比率。

2) 情绪过重 is_emotional（0 或 1）：若帖子或评论存在明显情绪过重倾向，如咒骂学校/专业、极度消极、中重度抑郁倾向等，则 is_emotional 为 1，否则为 0。

只输出如下格式的 JSON，不要 markdown 代码块包裹以外的内容：
{"usefulness_ratio": 数字, "is_emotional": 0或1}`;

  const prompt = `请分析以下帖子并只返回上述 JSON：\n\n${text.slice(0, 6000)}`;
  let raw;
  try {
    raw = await callDeepSeekAI(prompt, systemPrompt);
  } catch (e) {
    console.error('DeepSeek 分析帖子失败:', e.message);
    return;
  }
  let usefulness_ratio = null;
  let is_emotional = 0;
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]);
      const u = Number(obj.usefulness_ratio);
      if (!Number.isNaN(u) && u >= 0 && u <= 100) usefulness_ratio = u;
      if (obj.is_emotional === 1 || obj.is_emotional === true) is_emotional = 1;
    } catch (_) {}
  }
  const shouldDelete = (usefulness_ratio != null && usefulness_ratio < SHARE_USEFULNESS_THRESHOLD) || is_emotional === 1;

  // 基于 MySQL 中的类型词，对帖子进行本地分类占比分析并自动打标签（只作为初始标签，发帖人后续仍可在前端编辑）
  const { autoTags } = analyzeCategoryDistribution(text, keywordCategoriesMap);
  db.get(
    'SELECT tags FROM student_shares WHERE id = ?',
    [shareId],
    (selectErr, row) => {
      if (selectErr) {
        console.error('SELECT student_shares.tags 失败:', selectErr);
      }
      const existingTagsStr = row && row.tags ? String(row.tags) : '';
      const existingTags = existingTagsStr
        .split(/[,，、\s]+/)
        .map((t) => t.trim())
        .filter(Boolean);
      const merged = Array.from(new Set([...existingTags, ...autoTags]));
      const finalTagsStr = merged.join('、');

      db.run(
        `UPDATE student_shares SET usefulness_ratio = ?, is_emotional = ?, analyzed_at = NOW(), delete_after = ${
          shouldDelete ? "DATE_ADD(NOW(), INTERVAL 24 HOUR)" : 'NULL'
        }, tags = ? WHERE id = ?`,
        [usefulness_ratio, is_emotional, finalTagsStr, shareId],
        (err) => {
          if (err) console.error('UPDATE student_shares 分析结果失败:', err);
        }
      );
    }
  );
}

/** 评论发布后异步：DeepSeek 判断是否情绪过重，写回 is_emotional，过重则设 delete_after */
async function analyzeCommentAndUpdate(commentId, content) {
  if (!DEEPSEEK_API_KEY) return;
  const systemPrompt = `你是一个内容安全评估助手。只根据用户给出一段评论文本，判断是否「情绪过重」：如咒骂学校/专业、极度消极、中重度抑郁倾向等。只输出一个 JSON：{"is_emotional": 0 或 1}，不要其他内容。`;
  const prompt = `评论内容：\n${content.slice(0, 3000)}\n\n请只返回上述 JSON。`;
  let raw;
  try {
    raw = await callDeepSeekAI(prompt, systemPrompt);
  } catch (e) {
    console.error('DeepSeek 分析评论失败:', e.message);
    return;
  }
  let is_emotional = 0;
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]);
      if (obj.is_emotional === 1 || obj.is_emotional === true) is_emotional = 1;
    } catch (_) {}
  }
  const shouldDelete = is_emotional === 1;
  db.run(
    `UPDATE share_comments SET is_emotional = ?, analyzed_at = NOW(), delete_after = ${shouldDelete ? "DATE_ADD(NOW(), INTERVAL 24 HOUR)" : 'NULL'} WHERE id = ?`,
    [is_emotional, commentId],
    (err) => { if (err) console.error('UPDATE share_comments 分析结果失败:', err); }
  );
}

// ========== 路由 ==========

// 调试接口：直接查询数据库，不应用复杂的过滤条件
router.get('/debug/shares-all', async (req, res) => {
  try {
    const mysqlPool = getMysqlPool();
    if (!mysqlPool) {
      res.json({ code: 503, msg: "MySQL 未初始化", mysqlConfigured: false });
      return;
    }
    const [allShares] = await mysqlPool.query(
      `SELECT id, share_number, school, major, title, content, tags, images, author_nickname, 
              upload_time, status, usefulness_ratio, like_count 
       FROM student_shares ORDER BY id DESC LIMIT 100`
    );
    const [stats] = await mysqlPool.query(
      `SELECT status, COUNT(*) as count FROM student_shares GROUP BY status`
    );
    res.json({
      code: 200,
      total: allShares.length,
      stats: stats,
      shares: allShares,
      config: {
        SHARE_GRACE_MINUTES,
        SHARE_USEFULNESS_THRESHOLD
      }
    });
  } catch (err) {
    console.error('[DEBUG] /api/debug/shares-all 失败:', err);
    res.json({ code: 500, msg: err.message });
  }
});

// 获取列表：支持 school/major/keyword 筛选；带点赞数；过滤无用/情绪化/到期删除的；有 token/guestId 时带 user_has_liked
router.get('/student-shares', async (req, res) => {
  db.run(`UPDATE student_shares SET status = 'deleted' WHERE delete_after IS NOT NULL AND delete_after <= NOW()`, () => {});
  const { school, major, keyword } = req.query;
  const random = req.query && (req.query.random === '1' || req.query.random === 'true');
  const pageRaw = parseInt(req.query.page || '1', 10);
  const page = Number.isFinite(pageRaw) ? Math.max(1, pageRaw) : 1;
  const pageSizeRaw = parseInt(req.query.pageSize || '10', 10);
  const pageSize = Number.isFinite(pageSizeRaw) ? Math.min(Math.max(1, pageSizeRaw), 50) : 10;
  const offset = (page - 1) * pageSize;

  let sql = `SELECT s.id, s.share_number, s.school, s.major, s.grade, s.title, s.content, s.tags,
    s.author_nickname, s.upload_time, s.status, s.usefulness_ratio,
    COUNT(sl.share_id) AS like_count
    FROM student_shares s
    LEFT JOIN share_likes sl ON sl.share_id = s.id
    WHERE s.status = 'approved'
    AND (s.delete_after IS NULL OR s.delete_after > NOW())
    AND (
      s.upload_time >= DATE_SUB(NOW(), INTERVAL ${SHARE_GRACE_MINUTES} MINUTE)
      OR ( (s.usefulness_ratio IS NULL OR s.usefulness_ratio >= ${SHARE_USEFULNESS_THRESHOLD}) AND (s.is_emotional IS NULL OR s.is_emotional = 0) )
    )`;
  const params = [];

  if (school) {
    sql += ` AND s.school = ?`;
    params.push(school);
  }

  if (major) {
    sql += ` AND s.major = ?`;
    params.push(major);
  }

  if (keyword) {
    sql += ` AND (s.title LIKE ? OR s.content LIKE ? OR s.tags LIKE ?)`;
    params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
  }

  if (random) {
    const randomLimit = String(Math.min(pageSize, 10));
    const randomSql = `${sql} GROUP BY s.id ORDER BY RAND() LIMIT ?`;
    db.all(randomSql, [...params, randomLimit], async (err, rows) => {
      if (err) {
        console.error("获取学生分享失败(随机):", err);
        res.send({ code: 500, msg: "获取失败: " + err.message });
        return;
      }
      const token = getTokenFromRequest(req);
      const verified = await parseAuthToken(token || null);
      const guestId = (req.query && req.query.guestId != null) ? String(req.query.guestId).trim() : '';
      let userEmail = verified ? verified.email : (guestId ? 'guest_' + guestId : null);
      if (!userEmail && token) userEmail = 'token_' + crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 32);

      if (userEmail && rows && rows.length > 0) {
        const ids = rows.map((r) => r.id);
        const placeholders = ids.map(() => '?').join(',');
        const liked = await new Promise((resolve) => {
          db.all(`SELECT share_id FROM share_likes WHERE share_id IN (${placeholders}) AND user_email = ?`, [...ids, userEmail], (e, r) => resolve(e ? [] : (r || []).map((x) => x.share_id)));
        });
        rows.forEach((r) => { r.user_has_liked = liked.indexOf(r.id) !== -1; });
      } else {
        rows.forEach((r) => { r.user_has_liked = false; });
      }

      res.send({
        code: 200,
        data: rows || [],
        pagination: {
          page: 1,
          pageSize: Number(randomLimit),
          total: rows ? rows.length : 0,
          totalPages: 1,
          hasMore: false
        }
      });
    });
    return;
  }

  const countSql = sql.replace(/SELECT[\s\S]*?FROM/, 'SELECT COUNT(DISTINCT s.id) as total FROM');
  const countParams = [...params];

  db.get(countSql, countParams, (countErr, countRow) => {
    if (countErr) {
      console.error("获取分享总数失败:", countErr);
    }
    const total = countRow ? countRow.total : 0;

    sql += ` GROUP BY s.id ORDER BY s.upload_time DESC LIMIT ? OFFSET ?`;
    params.push(String(pageSize), String(offset));

    db.all(sql, params, async (err, rows) => {
      if (err) {
        console.error("获取学生分享失败:", err);
        res.send({ code: 500, msg: "获取失败: " + err.message });
        return;
      }

      console.log('[DEBUG] /api/student-shares 查询结果:');
      console.log('  - 页码:', page, '每页:', pageSize, '偏移:', offset);
      console.log('  - SQL条件: status=approved, grace=' + SHARE_GRACE_MINUTES + 'min, usefulness>=' + SHARE_USEFULNESS_THRESHOLD);
      console.log('  - 返回行数:', rows ? rows.length : 0, '/ 总数:', total);

      const token = getTokenFromRequest(req);
      const verified = await parseAuthToken(token || null);
      const guestId = (req.query && req.query.guestId != null) ? String(req.query.guestId).trim() : '';
      let userEmail = verified ? verified.email : (guestId ? 'guest_' + guestId : null);
      if (!userEmail && token) userEmail = 'token_' + crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 32);
      if (userEmail && rows && rows.length > 0) {
        const ids = rows.map((r) => r.id);
        const placeholders = ids.map(() => '?').join(',');
        const liked = await new Promise((resolve) => {
          db.all(`SELECT share_id FROM share_likes WHERE share_id IN (${placeholders}) AND user_email = ?`, [...ids, userEmail], (e, r) => resolve(e ? [] : (r || []).map((x) => x.share_id)));
        });
        rows.forEach((r) => { r.user_has_liked = liked.indexOf(r.id) !== -1; });
      } else {
        rows.forEach((r) => { r.user_has_liked = false; });
      }

      console.log('[DEBUG] 最终返回给前端:', rows ? rows.length : 0, '条数据');
      res.send({
        code: 200,
        data: rows,
        pagination: {
          page: page,
          pageSize: pageSize,
          total: total,
          totalPages: Math.ceil(total / pageSize),
          hasMore: offset + rows.length < total
        }
      });
    });
  });
});

// 按 ID 批量获取 images 字段（供前端渲染列表时补充图片，不阻塞列表加载）
router.get('/student-shares/images', (req, res) => {
  const idsParam = (req.query.ids || '').trim();
  if (!idsParam) return res.send({ code: 200, data: [] });
  const ids = idsParam.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n) && n > 0);
  if (ids.length === 0) return res.send({ code: 200, data: [] });
  if (ids.length > 100) ids.length = 100;
  const placeholders = ids.map(() => '?').join(',');
  db.all(`SELECT id, images FROM student_shares WHERE id IN (${placeholders})`, ids, (err, rows) => {
    if (err) return res.send({ code: 500, msg: '查询失败' });
    const map = {};
    (rows || []).forEach((r) => { map[r.id] = r.images || ''; });
    const result = ids.map((id) => ({ id, images: map[id] || '' }));
    res.send({ code: 200, data: result });
  });
});

// 按分享编号读取单条帖子（share_number 即 id，用于前端固定链接）
router.get('/student-shares/by-number/:share_number', (req, res) => {
  const shareNumber = parseInt(String(req.params.share_number), 10);
  if (Number.isNaN(shareNumber) || shareNumber < 1) {
    res.send({ code: 400, msg: "编号无效" });
    return;
  }
  db.get(
    `SELECT s.*, COUNT(sl.share_id) AS like_count FROM student_shares s LEFT JOIN share_likes sl ON sl.share_id = s.id WHERE s.share_number = ? GROUP BY s.id`,
    [shareNumber],
    (err, row) => {
      if (err) {
        res.send({ code: 500, msg: "查询失败" });
        return;
      }
      if (!row) {
        res.send({ code: 404, msg: "未找到该编号的帖子" });
        return;
      }
      res.send({ code: 200, data: row });
    }
  );
});

// 举报帖子；同一帖子举报数达到 REPORT_THRESHOLD 后 status 改为 pending_review
router.post('/student-shares/:id/report', async (req, res) => {
  const shareId = req.params.id;
  const token = getTokenFromRequest(req);
  const verified = await parseAuthToken(token || null);
  const userEmail = verified ? verified.email : 'anonymous';
  db.run('INSERT INTO share_reports (share_id, user_email) VALUES (?, ?)', [shareId, userEmail], function (err) {
    if (err) {
      res.send({ code: 500, msg: "举报失败" });
      return;
    }
    db.get('SELECT COUNT(*) AS cnt FROM share_reports WHERE share_id = ?', [shareId], (e, row) => {
      if (!e && row && row.cnt >= REPORT_THRESHOLD) {
        db.run("UPDATE student_shares SET status = 'pending_review' WHERE id = ?", [shareId], () => {});
      }
      res.send({ code: 200, msg: "举报已提交" });
    });
  });
});

// 点赞/取消点赞
router.post('/student-shares/:id/like', async (req, res) => {
  const shareId = parseInt(String(req.params.id), 10);
  if (Number.isNaN(shareId) || shareId < 1) {
    res.send({ code: 400, msg: "参数错误" });
    return;
  }
  const { token, guestId } = getLikeUserIdentity(req);
  const verified = await parseAuthToken(token || null);
  let userEmail = verified ? verified.email : (guestId ? 'guest_' + guestId : null);
  if (!userEmail && token) {
    userEmail = 'token_' + crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 32);
  }
  if (!userEmail) userEmail = 'guest_temp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
  db.get('SELECT id FROM student_shares WHERE id = ? AND status = ?', [shareId, 'approved'], (err, row) => {
    if (err || !row) {
      res.send({ code: 404, msg: "帖子不存在或已删除" });
      return;
    }
    db.get('SELECT 1 FROM share_likes WHERE share_id = ? AND user_email = ?', [shareId, userEmail], (e, likeRow) => {
      if (likeRow) {
        db.run('DELETE FROM share_likes WHERE share_id = ? AND user_email = ?', [shareId, userEmail], function (delErr) {
          if (delErr) {
            res.send({ code: 500, msg: "操作失败" });
            return;
          }
          db.get('SELECT COUNT(*) AS cnt FROM share_likes WHERE share_id = ?', [shareId], (_, c) => {
            res.send({ code: 200, liked: false, like_count: (c && c.cnt) || 0 });
          });
        });
      } else {
        db.run('INSERT INTO share_likes (share_id, user_email) VALUES (?, ?)', [shareId, userEmail], function (insErr) {
          if (insErr) {
            res.send({ code: 500, msg: "操作失败" });
            return;
          }
          db.get('SELECT COUNT(*) AS cnt FROM share_likes WHERE share_id = ?', [shareId], (_, c) => {
            res.send({ code: 200, liked: true, like_count: (c && c.cnt) || 0 });
          });
        });
      }
    });
  });
});

// GET 某帖子的评论列表（一级+回复，仅已通过；有 token/guestId 时带 user_has_liked）
router.get('/student-shares/:id/comments', async (req, res) => {
  const shareId = parseInt(String(req.params.id), 10);
  if (Number.isNaN(shareId) || shareId < 1) {
    res.send({ code: 400, msg: "参数错误" });
    return;
  }
  const token = getTokenFromRequest(req);
  const verified = await parseAuthToken(token || null);
  const guestId = (req.query && req.query.guestId != null) ? String(req.query.guestId).trim() : '';
  let userEmail = verified ? verified.email : (guestId ? 'guest_' + guestId : null);
  if (!userEmail && token) userEmail = 'token_' + crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 32);
  db.run(`UPDATE share_comments SET status = 'deleted' WHERE delete_after IS NOT NULL AND delete_after <= NOW()`, () => {});

  function sendCommentRows(rows) {
    if (!rows || rows.length === 0) return res.send({ code: 200, data: [] });
    const commentIds = rows.map((r) => r.id);
    let userLikedIds = [];
    if (userEmail) {
      const placeholders = commentIds.map(() => '?').join(',');
      db.all(`SELECT comment_id FROM comment_likes WHERE comment_id IN (${placeholders}) AND user_email = ?`, [...commentIds, userEmail], (e, r) => {
        if (!e && r) userLikedIds = (r || []).map((x) => x.comment_id);
        rows.forEach((row) => { row.user_has_liked = userLikedIds.indexOf(row.id) !== -1; });
        res.send({ code: 200, data: rows });
      });
    } else {
      rows.forEach((row) => { row.user_has_liked = false; });
      res.send({ code: 200, data: rows });
    }
  }

  const fullSql = `SELECT id, share_id, parent_id, user_email, school_name, nickname, content, status, like_count, created_at FROM share_comments WHERE share_id = ? AND status = 'approved'
     AND (is_emotional IS NULL OR is_emotional = 0)
     AND (delete_after IS NULL OR delete_after > NOW())
     ORDER BY created_at ASC`;
  const simpleSql = `SELECT id, share_id, parent_id, user_email, school_name, nickname, content, status, like_count, created_at FROM share_comments WHERE share_id = ? AND status = 'approved' ORDER BY created_at ASC`;

  db.all(fullSql, [shareId], (err, rows) => {
    if (err) {
      const msg = (err.message || '').toLowerCase();
      if (msg.includes('no such column') || msg.includes('is_emotional') || msg.includes('delete_after')) {
        db.all(simpleSql, [shareId], (err2, rows2) => {
          if (err2) {
            console.error('获取评论失败:', err2.message);
            return res.send({ code: 500, msg: "获取评论失败" });
          }
          sendCommentRows(rows2);
        });
        return;
      }
      console.error('获取评论失败:', err.message);
      return res.send({ code: 500, msg: "获取评论失败" });
    }
    sendCommentRows(rows);
  });
});

// POST 发表评论/回复
router.post('/student-shares/:id/comments', async (req, res) => {
  const shareId = parseInt(String(req.params.id), 10);
  if (Number.isNaN(shareId) || shareId < 1) {
    res.send({ code: 400, msg: "参数错误" });
    return;
  }
  const body = req.body || {};
  const { content, parent_id: parentId, identity, nickname: bodyNickname, school_name: bodySchool, guestId: bodyGuestId } = body;
  const contentTrim = (content != null ? String(content).trim() : '') || '';
  if (!contentTrim) {
    res.send({ code: 400, msg: "评论内容不能为空" });
    return;
  }
  const isVerified = identity === 'verified';
  const schoolName = isVerified ? (String(bodySchool != null ? bodySchool : '').trim() || '') : '游客';
  const nickname = isVerified ? (String(bodyNickname != null ? bodyNickname : '').trim() || '在读生') : '游客';
  const userEmail = isVerified ? (nickname + '_' + schoolName || 'verified') : ('guest_' + (String(bodyGuestId != null ? bodyGuestId : '').trim() || 'anonymous'));
  db.get('SELECT id FROM student_shares WHERE id = ? AND status = ?', [shareId, 'approved'], (err, shareRow) => {
    if (err || !shareRow) {
      res.send({ code: 404, msg: "帖子不存在或已删除" });
      return;
    }
    const finalParentId = parentId != null ? parseInt(String(parentId), 10) : null;
    function checkParentThenSubmit() {
      if (finalParentId != null && !Number.isNaN(finalParentId)) {
        db.get('SELECT id FROM share_comments WHERE id = ? AND share_id = ?', [finalParentId, shareId], (e, pr) => {
          if (e || !pr) {
            res.send({ code: 400, msg: "回复的评论不存在" });
            return;
          }
          submitCommentAfterModeration();
        });
      } else {
        submitCommentAfterModeration();
      }
    }
    async function submitCommentAfterModeration() {
      let commentStatus = 'approved';
      try {
        const modResult = await callBailianTextModeration('', contentTrim, '');
        if (modResult === 'block') {
          res.send({ code: 400, msg: "内容涉嫌违规，无法发布" });
          return;
        }
        if (modResult === 'review') commentStatus = 'pending_review';
      } catch (e) {
        console.error("评论内容审核异常，转待审:", e.message);
        commentStatus = 'pending_review';
      }
      db.run(
        'INSERT INTO share_comments (share_id, parent_id, user_email, school_name, nickname, content, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [shareId, (finalParentId != null && !Number.isNaN(finalParentId)) ? finalParentId : null, userEmail, schoolName, nickname, contentTrim, commentStatus],
        function (insErr) {
          if (insErr) {
            res.send({ code: 500, msg: "发表失败" });
            return;
          }
          const commentId = this.lastID;
          const msg = commentStatus === 'pending_review' ? "评论已提交，待审核通过后展示" : "评论成功";
          res.send({ code: 200, msg, id: commentId, status: commentStatus });
          analyzeCommentAndUpdate(commentId, contentTrim).catch(e => console.error('analyzeCommentAndUpdate error:', e));
        }
      );
    }
    checkParentThenSubmit();
  });
});

// 举报评论
router.post('/student-shares/:shareId/comments/:commentId/report', async (req, res) => {
  const commentId = parseInt(String(req.params.commentId), 10);
  if (Number.isNaN(commentId) || commentId < 1) {
    res.send({ code: 400, msg: "参数错误" });
    return;
  }
  const token = getTokenFromRequest(req);
  const verified = await parseAuthToken(token || null);
  const userEmail = verified ? verified.email : 'anonymous';
  db.run('INSERT INTO comment_reports (comment_id, user_email) VALUES (?, ?)', [commentId, userEmail], function (err) {
    if (err) {
      res.send({ code: 500, msg: "举报失败" });
      return;
    }
    db.get('SELECT COUNT(*) AS cnt FROM comment_reports WHERE comment_id = ?', [commentId], (e, row) => {
      if (!e && row && row.cnt >= REPORT_THRESHOLD) {
        db.run("UPDATE share_comments SET status = 'pending_review' WHERE id = ?", [commentId], () => {});
      }
      res.send({ code: 200, msg: "举报已提交" });
    });
  });
});

// 评论点赞/取消点赞
router.post('/student-shares/:shareId/comments/:commentId/like', async (req, res) => {
  const commentId = parseInt(String(req.params.commentId), 10);
  if (Number.isNaN(commentId) || commentId < 1) {
    res.send({ code: 400, msg: "参数错误" });
    return;
  }
  const { token, guestId } = getLikeUserIdentity(req);
  const verified = await parseAuthToken(token || null);
  let userEmail = verified ? verified.email : (guestId ? 'guest_' + guestId : null);
  if (!userEmail && token) {
    userEmail = 'token_' + crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 32);
  }
  if (!userEmail) userEmail = 'guest_temp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
  db.get('SELECT id, like_count FROM share_comments WHERE id = ? AND status = ?', [commentId, 'approved'], (err, row) => {
    if (err || !row) {
      res.send({ code: 404, msg: "评论不存在或已删除" });
      return;
    }
    db.get('SELECT 1 FROM comment_likes WHERE comment_id = ? AND user_email = ?', [commentId, userEmail], (e, likeRow) => {
      if (likeRow) {
        db.run('DELETE FROM comment_likes WHERE comment_id = ? AND user_email = ?', [commentId, userEmail], function (delErr) {
          if (delErr) {
            res.send({ code: 500, msg: "操作失败" });
            return;
          }
          db.run('UPDATE share_comments SET like_count = CASE WHEN like_count > 0 THEN like_count - 1 ELSE 0 END WHERE id = ?', [commentId], () => {});
          db.get('SELECT like_count FROM share_comments WHERE id = ?', [commentId], (_, c) => {
            res.send({ code: 200, liked: false, like_count: (c && c.like_count) || 0 });
          });
        });
      } else {
        db.run('INSERT INTO comment_likes (comment_id, user_email) VALUES (?, ?)', [commentId, userEmail], function (insErr) {
          if (insErr) {
            res.send({ code: 500, msg: "操作失败" });
            return;
          }
          db.run('UPDATE share_comments SET like_count = like_count + 1 WHERE id = ?', [commentId], () => {});
          db.get('SELECT like_count FROM share_comments WHERE id = ?', [commentId], (_, c) => {
            res.send({ code: 200, liked: true, like_count: (c && c.like_count) || 0 });
          });
        });
      }
    });
  });
});

// POST 提交学生分享：需认证；发帖前百炼审核内容，违规 block，存疑 pending_review；提交后异步 DeepSeek 分析有用度/情绪
router.post('/student-shares', async (req, res) => {
  const body = req.body || {};
  const { school, major, grade, title, content, tags, images, fromShareForm, nickname, author_nickname } = body;
  const token = getTokenFromRequest(req);

  if (!title || !content) {
    res.send({ code: 400, msg: "标题和内容为必填项" });
    return;
  }

  let verified = await parseAuthToken(token || null);
  let finalSchool = (school != null ? String(school).trim() : '') || '';
  let finalMajor = (major != null ? String(major) : '') || '';
  let authorNick = '在读生';

  if (verified) {
    authorNick = verified.nickname || '在读生';
    if (!finalSchool) {
      res.send({ code: 400, msg: "请确定认证学校（发帖必须为认证学校）" });
      return;
    }
    if (finalSchool !== verified.school_name) {
      res.send({ code: 403, msg: `您只能发布认证学校「${verified.school_name}」相关内容` });
      return;
    }
  } else {
    if (fromShareForm && finalSchool && title && content) {
      authorNick = (nickname != null ? String(nickname).trim() : '') || (author_nickname != null ? String(author_nickname).trim() : '') || '在读生';
    } else {
      res.send({ code: 403, msg: "请先完成信息认证" });
      return;
    }
  }

  let postStatus = 'approved';
  try {
    const modResult = await callBailianTextModeration(title, content, tags || '');
    if (modResult === 'block') {
      res.send({ code: 400, msg: "内容涉嫌违规，无法发布" });
      return;
    }
    if (modResult === 'review') postStatus = 'pending_review';
  } catch (e) {
    console.error("发帖内容审核异常，转后台审核:", e.message);
    postStatus = 'pending_review';
  }

  const imagesStr = images && Array.isArray(images) ? images.join(IMAGE_SEP) : '';
  const sql = `INSERT INTO student_shares (school, major, grade, title, content, tags, images, status, author_nickname) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  db.run(sql, [finalSchool, finalMajor, grade || '', title, content, tags || '', imagesStr, postStatus, authorNick], function (err) {
    if (err) {
      console.error("保存学生分享失败:", err);
      res.send({ code: 500, msg: "保存失败" });
      return;
    }
    const shareId = this.lastID;
    db.run('UPDATE student_shares SET share_number = ? WHERE id = ?', [shareId, shareId], () => {});
    const msg = postStatus === 'pending_review' ? "分享已提交，待人工审核通过后展示" : "分享提交成功！";
    res.send({ code: 200, msg, id: shareId, share_number: shareId, status: postStatus });
    analyzeShareAndUpdate(shareId, title, content, tags || '').catch(e => console.error('analyzeShareAndUpdate error:', e));
  });
});

// 将辅助函数挂载到 router，以便 app.js 中 aiQueryHelpers 使用
router.getSchoolFromPrompt = getSchoolFromPrompt;
router.fetchTopSharesBySchool = fetchTopSharesBySchool;
router.fetchTopSharesByKeyword = fetchTopSharesByKeyword;
router.fetchRelevantShares = fetchRelevantShares;
router.extractKeywords = extractKeywords;

module.exports = router;

/**
 * 管理后台路由 (admin.js)
 * 从 app.js 提取的所有管理员接口
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const { db, toMySQLDateTime, toTinyInt } = require('../config/db');
const { verifyAdmin, verifyAdminToken, checkAdminAuth, loginAdmin, logoutAdmin } = require('../middleware/admin');
const { callDataEntryAI } = require('../services/deepseek');

// 数据目录与备份路径（兼容非 Vercel 部署）
const DATA_DIR = process.env.VERCEL
  ? '/tmp'
  : (process.env.DATA_DIR || process.env.DATASET_MOUNT_PATH || '/home/user/app/data');
const DB_PATH = path.join(DATA_DIR, 'study_experience.db');

const TOKEN_EXPIRY_MS = 10 * 365 * 24 * 60 * 60 * 1000;

// ========== 管理员登录/登出 ==========

// POST /api/admin/login
router.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  const token = loginAdmin(password);
  if (!token) {
    res.send({ code: 403, msg: '密码错误' });
    return;
  }
  res.send({ code: 200, msg: '登录成功', token });
});

// POST /api/admin/logout
router.post('/api/admin/logout', (req, res) => {
  const token = req.headers['x-admin-token'] || req.query.token;
  logoutAdmin(token);
  res.send({ code: 200, msg: '已退出登录' });
});

// ========== 数据库备份 ==========

// GET /admin/backup/download-db
router.get('/admin/backup/download-db', (req, res) => {
  const pwd = checkAdminAuth(req);
  if (!pwd) {
    res.status(403).send('无权限');
    return;
  }
  if (process.env.VERCEL) {
    res.status(501).json({ code: 501, msg: '备份下载在 Vercel 环境下不可用，请从 MySQL 导出或使用自建服务器备份。' });
    return;
  }
  if (!fs.existsSync(DB_PATH)) {
    res.status(404).send('数据库文件不存在');
    return;
  }
  res.setHeader('Content-Disposition', 'attachment; filename="study_experience.db"');
  res.setHeader('Content-Type', 'application/octet-stream');
  fs.createReadStream(DB_PATH).pipe(res);
});

// ========== 学生证审核 ==========

// GET /admin/student-id-pending
router.get('/admin/student-id-pending', (req, res) => {
  const pwd = checkAdminAuth(req);
  if (!pwd) {
    res.send({ code: 403, msg: '无权限' });
    return;
  }
  db.all(
    'SELECT id, school_name, status, created_at FROM student_id_verifications WHERE status = ? ORDER BY created_at DESC',
    ['pending_manual'],
    (err, rows) => {
      if (err) {
        res.send({ code: 500, msg: '获取失败' });
        return;
      }
      res.send({ code: 200, data: rows });
    }
  );
});

// GET /admin/student-id-pending/:id
router.get('/admin/student-id-pending/:id', (req, res) => {
  const pwd = checkAdminAuth(req);
  if (!pwd) {
    res.send({ code: 403, msg: '无权限' });
    return;
  }
  db.get('SELECT id, school_name, image_data, status, created_at FROM student_id_verifications WHERE id = ?', [req.params.id], (err, row) => {
    if (err || !row) {
      res.send({ code: 404, msg: '记录不存在' });
      return;
    }
    res.send({
      code: 200,
      data: {
        id: row.id,
        school_name: row.school_name,
        status: row.status,
        created_at: row.created_at,
        imageDataUrl: row.image_data ? 'data:image/jpeg;base64,' + row.image_data : null
      }
    });
  });
});

// POST /admin/student-id-review
router.post('/admin/student-id-review', verifyAdminToken, (req, res) => {
  const { id, action } = req.body;
  if (!id || !['approve', 'reject'].includes(action)) {
    res.send({ code: 400, msg: '参数错误' });
    return;
  }
  db.get('SELECT id, school_name, status, nickname FROM student_id_verifications WHERE id = ?', [id], (err, row) => {
    if (err || !row) {
      res.send({ code: 404, msg: '记录不存在' });
      return;
    }
    if (row.status !== 'pending_manual') {
      res.send({ code: 400, msg: '该记录已处理' });
      return;
    }
    if (action === 'reject') {
      db.run('UPDATE student_id_verifications SET status = ? WHERE id = ?', ['rejected', id], (e) => {
        res.send(e ? { code: 500, msg: '操作失败' } : { code: 200, msg: '已拒绝' });
      });
      return;
    }
    const authToken = crypto.randomBytes(32).toString('hex');
    const tokenExpiresAt = new Date(Date.now() + TOKEN_EXPIRY_MS).toISOString();
    const sid = 'sid_' + id;
    const nick = (row.nickname || '').trim() || '在读生';
    db.run(
      'UPDATE student_id_verifications SET status = ?, auth_token = ?, token_expires_at = ? WHERE id = ?',
      ['approved', authToken, toMySQLDateTime(tokenExpiresAt), id],
      (e) => {
        if (e) {
          console.error('学生证通过-UPDATE失败:', e);
          res.send({ code: 500, msg: '操作失败' });
          return;
        }
        const insertCb = (e2) => {
          if (e2) {
            console.error('学生证通过-INSERT verified_users失败:', e2.message);
            if (String(e2.message).includes('duplicate') || String(e2.message).includes('UNIQUE')) {
              return res.send({ code: 200, msg: '已通过（该用户已认证）', authToken });
            }
            db.run(
              'REPLACE INTO verified_users (email, school_name, auth_type, auth_token, token_expires_at, nickname) VALUES (?, ?, ?, ?, ?, ?)',
              [sid, row.school_name, 'student_id', authToken, toMySQLDateTime(tokenExpiresAt), nick],
              (e3) => {
                if (e3) console.error('学生证通过-REPLACE verified_users 失败:', e3.message);
                res.send(e3 ? { code: 500, msg: '写入用户表失败，请查看服务端日志' } : { code: 200, msg: '已通过', authToken });
              }
            );
            return;
          }
          res.send({ code: 200, msg: '已通过', authToken });
        };
        db.run(
          'REPLACE INTO verified_users (email, school_name, auth_type, auth_token, token_expires_at, nickname) VALUES (?, ?, ?, ?, ?, ?)',
          [sid, row.school_name, 'student_id', authToken, toMySQLDateTime(new Date(Date.now() + TOKEN_EXPIRY_MS)), nick],
          insertCb
        );
      }
    );
  });
});

// ========== 被举报帖子管理 ==========

// GET /admin/reported-shares
router.get('/admin/reported-shares', (req, res) => {
  const pwd = checkAdminAuth(req);
  if (!pwd) {
    res.send({ code: 403, msg: '无权限' });
    return;
  }
  db.all(
    `SELECT s.id, s.school, s.major, s.title, s.content, s.upload_time, s.status,
      (SELECT COUNT(*) FROM share_reports r WHERE r.share_id = s.id) AS report_count
     FROM student_shares s WHERE s.status = 'pending_review' ORDER BY report_count DESC, s.upload_time DESC`,
    [],
    (err, rows) => {
      if (err) {
        res.send({ code: 500, msg: '获取失败' });
        return;
      }
      res.send({ code: 200, data: rows });
    }
  );
});

// POST /admin/student-shares/:id/delete
router.post('/admin/student-shares/:id/delete', verifyAdminToken, (req, res) => {
  const id = req.params.id;
  db.run("UPDATE student_shares SET status = 'deleted' WHERE id = ?", [id], function (err) {
    if (err) {
      res.send({ code: 500, msg: '操作失败' });
      return;
    }
    res.send({ code: 200, msg: this.changes ? '已删除' : '记录不存在或已删除' });
  });
});

// POST /admin/student-shares/:id/approve
router.post('/admin/student-shares/:id/approve', verifyAdminToken, (req, res) => {
  const id = req.params.id;
  db.run("UPDATE student_shares SET status = 'approved' WHERE id = ? AND status = 'pending_review'", [id], function (err) {
    if (err) {
      res.send({ code: 500, msg: '操作失败' });
      return;
    }
    res.send({ code: 200, msg: this.changes ? '已通过，帖子将公开展示' : '记录不存在或已处理' });
  });
});

// ========== 专业概览 CRUD ==========

// GET /admin/majors
router.get('/admin/majors', (req, res) => {
  const sql = `SELECT * FROM major_overviews ORDER BY category, major_name`;
  db.all(sql, [], (err, rows) => {
    if (err) {
      console.error('获取专业列表失败:', err);
      res.send({ code: 500, msg: '获取失败' });
      return;
    }
    res.send({ code: 200, data: rows });
  });
});

// POST /admin/majors
router.post('/admin/majors', verifyAdminToken, (req, res) => {
  const { password, major_code, major_name, category, degree_type, duration, description, core_courses, career_prospects, related_majors } = req.body;
  const sql = `INSERT INTO major_overviews (major_code, major_name, category, degree_type, duration, description, core_courses, career_prospects, related_majors) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  db.run(sql, [major_code, major_name, category, degree_type, duration, description, core_courses, career_prospects, related_majors], function(err) {
    if (err) {
      console.error('添加专业失败:', err);
      res.send({ code: 500, msg: '添加失败: ' + err.message });
      return;
    }
    res.send({ code: 200, msg: '添加成功', id: this.lastID });
  });
});

// PUT /admin/majors/:id
router.put('/admin/majors/:id', verifyAdminToken, (req, res) => {
  const { password, major_code, major_name, category, degree_type, duration, description, core_courses, career_prospects, related_majors } = req.body;
  const id = req.params.id;
  const sql = `UPDATE major_overviews SET major_code = ?, major_name = ?, category = ?, degree_type = ?, duration = ?, description = ?, core_courses = ?, career_prospects = ?, related_majors = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`;
  db.run(sql, [major_code, major_name, category, degree_type, duration, description, core_courses, career_prospects, related_majors, id], function(err) {
    if (err) {
      console.error('更新专业失败:', err);
      res.send({ code: 500, msg: '更新失败: ' + err.message });
      return;
    }
    res.send({ code: 200, msg: '更新成功' });
  });
});

// DELETE /admin/majors/:id
router.delete('/admin/majors/:id', verifyAdminToken, (req, res) => {
  const { password } = req.body;
  const id = req.params.id;
  const sql = `DELETE FROM major_overviews WHERE id = ?`;
  db.run(sql, [id], function(err) {
    if (err) {
      console.error('删除专业失败:', err);
      res.send({ code: 500, msg: '删除失败' });
      return;
    }
    res.send({ code: 200, msg: '删除成功' });
  });
});

// GET /admin/majors/:id/programs
router.get('/admin/majors/:id/programs', (req, res) => {
  const majorId = req.params.id;
  const sql = `SELECT * FROM school_programs WHERE major_id = ? ORDER BY school_name`;
  db.all(sql, [majorId], (err, rows) => {
    if (err) {
      console.error('获取开设院校失败:', err);
      res.send({ code: 500, msg: '获取失败' });
      return;
    }
    res.send({ code: 200, data: rows });
  });
});

// ========== 开设院校 CRUD ==========

// POST /admin/programs
router.post('/admin/programs', verifyAdminToken, (req, res) => {
  const { password, major_id, school_name, school_level, location, program_features, courses, admission_requirements, tuition_fee, scholarships, contact_info } = req.body;
  const sql = `INSERT INTO school_programs (major_id, school_name, school_level, location, program_features, courses, course_intros, admission_requirements, tuition_fee, scholarships, contact_info) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  db.run(sql, [major_id, school_name, school_level, location, program_features, courses, '', admission_requirements, tuition_fee, scholarships, contact_info], function(err) {
    if (err) {
      console.error('添加开设院校失败:', err);
      res.send({ code: 500, msg: '添加失败: ' + err.message });
      return;
    }
    res.send({ code: 200, msg: '添加成功', id: this.lastID });
  });
});

// PUT /api/admin/programs/:id
router.put('/api/admin/programs/:id', verifyAdminToken, (req, res) => {
  const { password, school_name, school_level, location, program_features, courses, admission_requirements, tuition_fee, scholarships, contact_info } = req.body;
  const id = req.params.id;
  const sql = `UPDATE school_programs SET school_name = ?, school_level = ?, location = ?, program_features = ?, courses = ?, admission_requirements = ?, tuition_fee = ?, scholarships = ?, contact_info = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`;
  db.run(sql, [school_name, school_level, location, program_features, courses, admission_requirements, tuition_fee, scholarships, contact_info, id], function(err) {
    if (err) {
      console.error('更新开设院校失败:', err);
      res.send({ code: 500, msg: '更新失败: ' + err.message });
      return;
    }
    res.send({ code: 200, msg: '更新成功' });
  });
});

// DELETE /api/admin/programs/:id
router.delete('/api/admin/programs/:id', verifyAdminToken, (req, res) => {
  const { password } = req.body;
  const id = req.params.id;
  const sql = `DELETE FROM school_programs WHERE id = ?`;
  db.run(sql, [id], function(err) {
    if (err) {
      console.error('删除开设院校失败:', err);
      res.send({ code: 500, msg: '删除失败' });
      return;
    }
    res.send({ code: 200, msg: '删除成功' });
  });
});

// ========== 专业动态/新闻 CRUD ==========

// GET /api/admin/majors/:id/news
router.get('/api/admin/majors/:id/news', (req, res) => {
  const majorId = req.params.id;
  const sql = `SELECT * FROM major_news WHERE major_id = ? ORDER BY is_hot DESC, created_at DESC`;
  db.all(sql, [majorId], (err, rows) => {
    if (err) {
      console.error('获取专业动态失败:', err);
      res.send({ code: 500, msg: '获取失败' });
      return;
    }
    res.send({ code: 200, data: rows });
  });
});

// 兼容旧前端路径
router.get('/admin/majors/:id/news', (req, res) => {
  const majorId = req.params.id;
  const sql = `SELECT * FROM major_news WHERE major_id = ? ORDER BY is_hot DESC, created_at DESC`;
  db.all(sql, [majorId], (err, rows) => {
    if (err) {
      console.error('获取专业动态失败:', err);
      res.send({ code: 500, msg: '获取失败' });
      return;
    }
    res.send({ code: 200, data: rows });
  });
});

// POST /api/admin/news
router.post('/api/admin/news', verifyAdminToken, (req, res) => {
  const { password, major_id, title, content, source, publish_date, is_hot } = req.body;
  const sql = `INSERT INTO major_news (major_id, title, content, source, publish_date, is_hot) VALUES (?, ?, ?, ?, ?, ?)`;
  db.run(sql, [major_id, title, content, source, publish_date, toTinyInt(is_hot)], function(err) {
    if (err) {
      console.error('添加专业动态失败:', err);
      res.send({ code: 500, msg: '添加失败: ' + err.message });
      return;
    }
    res.send({ code: 200, msg: '添加成功', id: this.lastID });
  });
});

// 兼容旧前端路径
router.post('/admin/news', verifyAdminToken, (req, res) => {
  const { password, major_id, title, content, source, publish_date, is_hot } = req.body;
  const sql = `INSERT INTO major_news (major_id, title, content, source, publish_date, is_hot) VALUES (?, ?, ?, ?, ?, ?)`;
  db.run(sql, [major_id, title, content, source, publish_date, toTinyInt(is_hot)], function(err) {
    if (err) {
      console.error('添加专业动态失败:', err);
      res.send({ code: 500, msg: '添加失败: ' + err.message });
      return;
    }
    res.send({ code: 200, msg: '添加成功', id: this.lastID });
  });
});

// PUT /api/admin/news/:id
router.put('/api/admin/news/:id', verifyAdminToken, (req, res) => {
  const { password, title, content, source, publish_date, is_hot } = req.body;
  const id = req.params.id;
  const sql = `UPDATE major_news SET title = ?, content = ?, source = ?, publish_date = ?, is_hot = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`;
  db.run(sql, [title, content, source, publish_date, toTinyInt(is_hot), id], function(err) {
    if (err) {
      console.error('更新专业动态失败:', err);
      res.send({ code: 500, msg: '更新失败: ' + err.message });
      return;
    }
    res.send({ code: 200, msg: '更新成功' });
  });
});

// 兼容旧前端路径
router.put('/admin/news/:id', verifyAdminToken, (req, res) => {
  const { password, title, content, source, publish_date, is_hot } = req.body;
  const id = req.params.id;
  const sql = `UPDATE major_news SET title = ?, content = ?, source = ?, publish_date = ?, is_hot = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`;
  db.run(sql, [title, content, source, publish_date, toTinyInt(is_hot), id], function(err) {
    if (err) {
      console.error('更新专业动态失败:', err);
      res.send({ code: 500, msg: '更新失败: ' + err.message });
      return;
    }
    res.send({ code: 200, msg: '更新成功' });
  });
});

// DELETE /api/admin/news/:id
router.delete('/api/admin/news/:id', verifyAdminToken, (req, res) => {
  const { password } = req.body;
  const id = req.params.id;
  const sql = `DELETE FROM major_news WHERE id = ?`;
  db.run(sql, [id], function(err) {
    if (err) {
      console.error('删除专业动态失败:', err);
      res.send({ code: 500, msg: '删除失败' });
      return;
    }
    res.send({ code: 200, msg: '删除成功' });
  });
});

// 兼容旧前端路径
router.delete('/admin/news/:id', verifyAdminToken, (req, res) => {
  const { password } = req.body;
  const id = req.params.id;
  const sql = `DELETE FROM major_news WHERE id = ?`;
  db.run(sql, [id], function(err) {
    if (err) {
      console.error('删除专业动态失败:', err);
      res.send({ code: 500, msg: '删除失败' });
      return;
    }
    res.send({ code: 200, msg: '删除成功' });
  });
});

// ========== 学校管理 ==========

// POST /api/admin/schools
router.post('/api/admin/schools', verifyAdminToken, (req, res) => {
  const { password, school_name, school_level, location, description } = req.body;
  const sql = `INSERT INTO schools (school_name, school_level, location, description) VALUES (?, ?, ?, ?)`;
  db.run(sql, [school_name, school_level, location, description], function(err) {
    if (err) {
      console.error('添加学校失败:', err);
      res.send({ code: 500, msg: '添加失败: ' + err.message });
      return;
    }
    res.send({ code: 200, msg: '添加成功', id: this.lastID });
  });
});

// POST /api/admin/school-programs
router.post('/api/admin/school-programs', verifyAdminToken, (req, res) => {
  const { password, school_name, major_id, major_name, program_features, courses, stream_division, admission_requirements, tuition_fee, scholarships, contact_info } = req.body;
  if (!school_name || !major_id) {
    res.send({ code: 400, msg: '学校名称和专业ID为必填项' });
    return;
  }
  const sql = `INSERT INTO school_major_programs (school_name, major_id, major_name, program_features, courses, stream_division, admission_requirements, tuition_fee, scholarships, contact_info) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  db.run(sql, [school_name, major_id, major_name, program_features, courses, stream_division, admission_requirements, tuition_fee, scholarships, contact_info], function(err) {
    if (err) {
      console.error('添加学校专业项目失败:', err);
      res.send({ code: 500, msg: '添加失败: ' + err.message });
      return;
    }
    res.send({ code: 200, msg: '添加成功', id: this.lastID });
  });
});

// ========== AI 数据录入（DeepSeek）辅助函数 ==========

/** 查 school_programs 表，该专业+该学校是否已有记录 */
function schoolProgramExists(majorId, schoolName) {
  return new Promise((resolve) => {
    db.get('SELECT id FROM school_programs WHERE major_id = ? AND school_name = ?', [majorId, schoolName], (err, row) => resolve(!!(row && !err)));
  });
}

/** 用 AI 根据学校官网判断是否开设某专业；必须依据官网/招生页等可查证来源，未检索到则返回 false */
async function confirmSchoolOffersMajor(schoolName, majorName) {
  const systemPrompt = '你是教育数据录入助手。判断某校是否开设某专业时，必须仅依据该校官方网站、招生网、本科招生目录等可查证来源；未在官网检索到明确信息时一律返回 offers: false，不得凭猜测或训练数据推断。';
  const prompt = `请仅根据「${schoolName}」官方网站（院校官网、招生网、本科招生目录等）的实际可查信息，判断该校是否开设「${majorName}」本科专业。
只返回一个 JSON：若在官网/招生页明确查到该专业招生或培养信息则 {"offers": true}，若未检索到或无法从官网确认则 {"offers": false}。不得猜测，未查到则必须返回 offers: false。`;
  const raw = await callDataEntryAI(prompt, systemPrompt);
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const obj = JSON.parse(m[0]);
      if (obj.offers === false) return false;
    } catch (_) {}
  }
  return true;
}

/** 根据专业名+学校名：若专业已存在则只查该校该专业开设信息；否则从阳光高考+官网查全量并建 major_overviews + 返回 program 数据 */
async function getOrCreateMajorAndProgramData(majorName, schoolName) {
  const offers = await confirmSchoolOffersMajor(schoolName, majorName);
  if (!offers) throw new Error('未检索到该校开设该专业，不录入');

  const existing = await new Promise((resolve) => {
    db.get('SELECT id FROM major_overviews WHERE major_name = ?', [majorName], (err, row) => resolve(err ? null : row));
  });
  const officialSource = `所有开设院校信息、培养计划、课程等必须仅来自「${schoolName}」官方网站，不得编造或使用非官网来源。`;
  if (existing) {
    const prompt = `请从「${schoolName}」官方网站（院校官网）检索「${majorName}」专业在该校的开设信息。${officialSource}
以JSON格式返回：
{"school_level":"院校层次","location":"所在城市","program_features":"培养特色（200字以内）","courses":"主要课程，逗号分隔","course_intros":[{"name":"课程名","intro":"课程基本介绍（50-100字）"}，可多项，无介绍则intro为空字符串],"admission_requirements":"招生要求","tuition_fee":"学费","scholarships":"奖学金","contact_info":"招生办联系方式"}`;
    const aiResponse = await callDataEntryAI(prompt);
    const m = aiResponse.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('AI返回解析失败');
    const raw = JSON.parse(m[0]);
    const programData = {
      school_level: raw.school_level || '',
      location: raw.location || '',
      program_features: raw.program_features || '',
      courses: raw.courses || '',
      course_intros: Array.isArray(raw.course_intros) ? JSON.stringify(raw.course_intros) : '',
      admission_requirements: raw.admission_requirements || '',
      tuition_fee: raw.tuition_fee || '',
      scholarships: raw.scholarships || '',
      contact_info: raw.contact_info || ''
    };
    return { majorId: existing.id, programData };
  }
  const fullPrompt = `请按以下两个数据源分别检索并合并为一条JSON（用于系统录入，缺项填空字符串）：
1）专业概况（介绍、培养方案、修读课程、招生计划、学科门类、学位、学制、就业、相关专业）请前往阳光高考平台（gaokao.chsi.com.cn）查询「${majorName}」专业。
2）该校该专业的开设情况必须仅从「${schoolName}」官方网站（院校官网）查询。${officialSource}
严格按以下JSON格式返回：
{
  "description": "专业介绍（300字以内）",
  "training_plan": "培养方案要点（300字以内）",
  "core_courses": "修读课程，逗号分隔",
  "admission_plan": "招生计划（200字以内）",
  "category": "所属学科门类",
  "degree_type": "学位类型",
  "duration": "学制",
  "career_prospects": "就业前景简述",
  "related_majors": "相关专业，逗号分隔",
  "school_level": "院校层次",
  "location": "院校所在城市",
  "program_features": "该校该专业培养特色（200字以内）",
  "courses": "该校开设的主要课程，逗号分隔",
  "course_intros": [{"name":"课程名","intro":"课程基本介绍（50-100字）"}，可多项，无介绍则intro为空字符串],
  "admission_requirements": "招生要求",
  "tuition_fee": "学费",
  "scholarships": "奖学金",
  "contact_info": "招生办联系方式"
}`;
  const aiResponse = await callDataEntryAI(fullPrompt);
  const m = aiResponse.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('AI返回解析失败');
  const data = JSON.parse(m[0]);
  const majorId = await new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO major_overviews (major_name, category, degree_type, duration, description, core_courses, career_prospects, related_majors, training_plan, admission_plan) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        majorName,
        data.category || '',
        data.degree_type || '',
        data.duration || '',
        data.description || '',
        data.core_courses || '',
        data.career_prospects || '',
        data.related_majors || '',
        data.training_plan || '',
        data.admission_plan || ''
      ],
      function (err) {
        if (err) reject(err);
        else resolve(this.lastID);
      }
    );
  });
  const programData = {
    school_level: data.school_level || '',
    location: data.location || '',
    program_features: data.program_features || '',
    courses: data.courses || '',
    course_intros: Array.isArray(data.course_intros) ? JSON.stringify(data.course_intros) : '',
    admission_requirements: data.admission_requirements || '',
    tuition_fee: data.tuition_fee || '',
    scholarships: data.scholarships || '',
    contact_info: data.contact_info || ''
  };
  return { majorId, programData };
}

// ========== AI 数据录入路由 ==========

// POST /api/admin/ai-add-program
router.post('/api/admin/ai-add-program', verifyAdminToken, async (req, res) => {
  const { password, school_name, major_name } = req.body;
  if (!school_name || !major_name) {
    res.send({ code: 400, msg: '学校名称和专业名称为必填项' });
    return;
  }
  const sName = school_name.trim();
  const mName = major_name.trim();
  try {
    const { majorId, programData } = await getOrCreateMajorAndProgramData(mName, sName);
    const exists = await schoolProgramExists(majorId, sName);
    if (exists) {
      res.send({ code: 200, msg: '该专业下该院校已录入，已跳过', skipped: true, id: majorId, data: programData });
      return;
    }
    await new Promise((resolve, reject) => {
      const sql = `INSERT INTO school_programs (major_id, school_name, school_level, location, program_features, courses, course_intros, admission_requirements, tuition_fee, scholarships, contact_info) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
      db.run(sql, [
        majorId,
        sName,
        programData.school_level || '',
        programData.location || '',
        programData.program_features || '',
        programData.courses || '',
        programData.course_intros || '',
        programData.admission_requirements || '',
        programData.tuition_fee || '',
        programData.scholarships || '',
        programData.contact_info || ''
      ], function (insertErr) {
        if (insertErr) reject(insertErr);
        else resolve(this.lastID);
      });
    });
    db.run(`INSERT IGNORE INTO schools (school_name, school_level, location) VALUES (?, ?, ?)`, [sName, programData.school_level || '', programData.location || '']);
    res.send({ code: 200, msg: 'AI检索并添加成功', id: majorId, data: programData });
  } catch (e) {
    console.error('AI添加失败:', e);
    const { DEEPSEEK_API_KEY } = require('../services/deepseek');
    const hint = !DEEPSEEK_API_KEY ? ' 请在后端服务器环境变量中配置 DEEPSEEK_API_KEY。' : '';
    res.send({ code: 500, msg: 'AI检索失败: ' + e.message + hint });
  }
});

// POST /admin/ai-add-program
router.post('/admin/ai-add-program', verifyAdminToken, async (req, res) => {
  const { password, school_name, major_name } = req.body;
  if (!school_name || !major_name) {
    res.send({ code: 400, msg: '学校名称和专业名称为必填项' });
    return;
  }
  const sName = school_name.trim();
  const mName = major_name.trim();
  try {
    const { majorId, programData } = await getOrCreateMajorAndProgramData(mName, sName);
    const exists = await schoolProgramExists(majorId, sName);
    if (exists) {
      res.send({ code: 200, msg: '该专业下该院校已录入，已跳过', skipped: true, id: majorId, data: programData });
      return;
    }
    await new Promise((resolve, reject) => {
      const sql = `INSERT INTO school_programs (major_id, school_name, school_level, location, program_features, courses, course_intros, admission_requirements, tuition_fee, scholarships, contact_info) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
      db.run(sql, [majorId, sName, programData.school_level || '', programData.location || '', programData.program_features || '', programData.courses || '', programData.course_intros || '', programData.admission_requirements || '', programData.tuition_fee || '', programData.scholarships || '', programData.contact_info || ''], function (insertErr) {
        if (insertErr) reject(insertErr);
        else resolve(this.lastID);
      });
    });
    db.run(`INSERT IGNORE INTO schools (school_name, school_level, location) VALUES (?, ?, ?)`, [sName, programData.school_level || '', programData.location || '']);
    res.send({ code: 200, msg: 'AI检索并添加成功', id: majorId, data: programData });
  } catch (e) {
    console.error('AI添加失败:', e);
    const { DEEPSEEK_API_KEY } = require('../services/deepseek');
    const hint = !DEEPSEEK_API_KEY ? ' 请在后端服务器环境变量中配置 DEEPSEEK_API_KEY。' : '';
    res.send({ code: 500, msg: 'AI检索失败: ' + e.message + hint });
  }
});

// POST /api/admin/ai-batch-add
router.post('/api/admin/ai-batch-add', verifyAdminToken, async (req, res) => {
  const { password, school_name, majors } = req.body;
  if (!school_name || !majors || !Array.isArray(majors)) {
    res.send({ code: 400, msg: '参数错误' });
    return;
  }
  const results = [];
  const errors = [];
  const name = school_name.trim();
  for (const major of majors) {
    const majorStr = String(major).trim();
    if (!majorStr) continue;
    try {
      const { majorId, programData } = await getOrCreateMajorAndProgramData(majorStr, name);
      if (await schoolProgramExists(majorId, name)) {
        results.push({ major: majorStr, status: 'skipped', msg: '该院校该专业已录入' });
        continue;
      }
      await new Promise((resolve, reject) => {
        const sql = `INSERT INTO school_programs (major_id, school_name, school_level, location, program_features, courses, course_intros, admission_requirements, tuition_fee, scholarships, contact_info) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        db.run(sql, [
          majorId,
          name,
          programData.school_level || '',
          programData.location || '',
          programData.program_features || '',
          programData.courses || '',
          programData.course_intros || '',
          programData.admission_requirements || '',
          programData.tuition_fee || '',
          programData.scholarships || '',
          programData.contact_info || ''
        ], function (err) {
          if (err) reject(err);
          else resolve(this.lastID);
        });
      });
      db.run(`INSERT IGNORE INTO schools (school_name, school_level, location) VALUES (?, ?, ?)`, [name, programData.school_level || '', programData.location || '']);
      results.push({ major: majorStr, status: 'success' });
    } catch (err) {
      errors.push({ major: majorStr, error: err.message });
    }
  }
  res.send({
    code: 200,
    msg: `批量添加完成，成功${results.length}个，失败${errors.length}个`,
    results,
    errors
  });
});

// POST /admin/ai-batch-add
router.post('/admin/ai-batch-add', verifyAdminToken, async (req, res) => {
  const { password, school_name, majors } = req.body;
  if (!school_name || !majors || !Array.isArray(majors)) {
    res.send({ code: 400, msg: '参数错误' });
    return;
  }
  const results = [];
  const errors = [];
  const name = school_name.trim();
  for (const major of majors) {
    const majorStr = String(major).trim();
    if (!majorStr) continue;
    try {
      const { majorId, programData } = await getOrCreateMajorAndProgramData(majorStr, name);
      if (await schoolProgramExists(majorId, name)) {
        results.push({ major: majorStr, status: 'skipped', msg: '该院校该专业已录入' });
        continue;
      }
      await new Promise((resolve, reject) => {
        const sql = `INSERT INTO school_programs (major_id, school_name, school_level, location, program_features, courses, course_intros, admission_requirements, tuition_fee, scholarships, contact_info) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        db.run(sql, [majorId, name, programData.school_level || '', programData.location || '', programData.program_features || '', programData.courses || '', programData.course_intros || '', programData.admission_requirements || '', programData.tuition_fee || '', programData.scholarships || '', programData.contact_info || ''], function (err) {
          if (err) reject(err);
          else resolve(this.lastID);
        });
      });
      db.run(`INSERT IGNORE INTO schools (school_name, school_level, location) VALUES (?, ?, ?)`, [name, programData.school_level || '', programData.location || '']);
      results.push({ major: majorStr, status: 'success' });
    } catch (err) {
      errors.push({ major: majorStr, error: err.message });
    }
  }
  res.send({ code: 200, msg: `批量添加完成，成功${results.length}个，失败${errors.length}个`, results, errors });
});

// 管理员：只填学校名，AI 拉取该校本科招生专业列表并逐个录入
const handleAiAddSchoolAllMajors = async (req, res) => {
  const { password, school_name } = req.body;
  if (!school_name || !school_name.trim()) {
    res.send({ code: 400, msg: '请填写学校名称' });
    return;
  }
  const name = school_name.trim();
  const results = [];
  const errors = [];
  try {
    const listPrompt = `请列出「${name}」的本科招生专业列表。只返回一个 JSON 数组，格式为 ["专业名称1", "专业名称2", ...]，不要其他说明。`;
    const listResponse = await callDataEntryAI(listPrompt, '你只输出一个 JSON 数组，不要 markdown 代码块包裹。');
    let majorNames = [];
    const arrMatch = listResponse.match(/\[[\s\S]*\]/);
    if (arrMatch) {
      try {
        majorNames = JSON.parse(arrMatch[0]);
        if (!Array.isArray(majorNames)) majorNames = [];
      } catch (_) {}
    }
    if (majorNames.length === 0) {
      res.send({ code: 500, msg: '未能解析到招生专业列表，请稍后重试或手动填写专业' });
      return;
    }
    for (const major of majorNames) {
      const majorStr = String(major).trim();
      if (!majorStr) continue;
      try {
        const { majorId, programData } = await getOrCreateMajorAndProgramData(majorStr, name);
        if (await schoolProgramExists(majorId, name)) {
          results.push({ major: majorStr, status: 'skipped', msg: '该院校该专业已录入' });
          continue;
        }
        await new Promise((resolve, reject) => {
          const sql = `INSERT INTO school_programs (major_id, school_name, school_level, location, program_features, courses, course_intros, admission_requirements, tuition_fee, scholarships, contact_info) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
          db.run(sql, [
            majorId,
            name,
            programData.school_level || '',
            programData.location || '',
            programData.program_features || '',
            programData.courses || '',
            programData.course_intros || '',
            programData.admission_requirements || '',
            programData.tuition_fee || '',
            programData.scholarships || '',
            programData.contact_info || ''
          ], function (err) {
            if (err) reject(err);
            else resolve(this.lastID);
          });
        });
        db.run(`INSERT IGNORE INTO schools (school_name, school_level, location) VALUES (?, ?, ?)`, [name, programData.school_level || '', programData.location || '']);
        results.push({ major: majorStr, status: 'success' });
      } catch (err) {
        errors.push({ major: majorStr, error: err.message });
      }
    }
    res.send({
      code: 200,
      msg: `已检索并添加完成，成功 ${results.length} 个，失败 ${errors.length} 个`,
      results,
      errors
    });
  } catch (err) {
    console.error('AI 按学校添加所有专业失败:', err);
    const msg = err.message || '';
    const { DEEPSEEK_API_KEY } = require('../services/deepseek');
    const hint = !DEEPSEEK_API_KEY
      ? ' 请在后端服务器环境变量中配置 DEEPSEEK_API_KEY。'
      : '';
    res.send({ code: 500, msg: '检索失败: ' + msg + hint });
  }
};

// POST /api/admin/ai-add-school-all-majors
router.post('/api/admin/ai-add-school-all-majors', verifyAdminToken, handleAiAddSchoolAllMajors);
// POST /admin/ai-add-school-all-majors
router.post('/admin/ai-add-school-all-majors', verifyAdminToken, handleAiAddSchoolAllMajors);

module.exports = router;

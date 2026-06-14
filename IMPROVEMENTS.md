# getothetop 项目系统性改进建议

> 分析日期：2026-06-16  
> 分析范围：app.js（3,282 行）、4 个前端 HTML、package.json、Dockerfile、vercel.json、stepfun-ai.js、migrate.js

---

## 一、优先级总览

| 优先级 | 类别 | 问题数量 | 风险等级 |
|--------|------|----------|----------|
| **P0** | 安全漏洞 | 6 | 🔴 高危 |
| **P1** | 架构与代码质量 | 7 | 🟠 中高危 |
| **P2** | 性能与数据库 | 6 | 🟡 中等 |
| **P3** | 部署与运维 | 5 | 🟢 低危 |
| **P4** | 产品体验 | 4 | 🔵 优化 |

---

## 二、P0 — 安全漏洞（必须立即修复）

### 2.1 管理员密码硬编码

**位置**：`app.js:949`
```js
const ADMIN_PASSWORD = 'a~a~ycyzword+';
```
**风险**：密码直接暴露在 Git 历史中，任何能访问仓库的人即可进入管理后台。  
**修复**：移入环境变量，启动时校验不为空。

```js
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 12) {
  console.error('❌ ADMIN_PASSWORD 未设置或太短（至少12位）');
  process.exit(1);
}
```

### 2.2 MySQL 连接信息暴露

**位置**：`app.js:129`
```js
const MYSQL_HOST = process.env.MYSQL_HOST || '115.29.233.160';
```
**风险**：公网 IP 直接暴露，默认连接远程数据库，易被扫描攻击。  
**修复**：去掉默认值，强制环境变量配置。

```js
const MYSQL_HOST = process.env.MYSQL_HOST;
if (!MYSQL_HOST) {
  console.error('❌ MYSQL_HOST 未配置');
  process.exit(1);
}
```

### 2.3 迁移脚本硬编码密码

**位置**：`migrate.js:8-10`
```js
mysql: {
    host: '172.17.0.1',
    user: 'root',
    password: '@Ycyz120',
}
```
**风险**：生产密码泄露在代码中。  
**修复**：改为从环境变量读取，或单独创建 `.env.migrate`（加入 .gitignore）。

### 2.4 CORS 完全开放

**位置**：`app.js:599`
```js
app.use(cors());
```
**风险**：任何域名均可调用 API，配合 Cookie/Token 可构成 CSRF 风险。  
**修复**：按环境配置白名单。

```js
const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map(s => s.trim())
  : process.env.NODE_ENV === 'production' ? [] : ['http://localhost:3000'];
app.use(cors({ origin: allowedOrigins, credentials: true }));
```

### 2.5 缺乏安全响应头

**风险**：无 CSP、X-Frame-Options、HSTS 等基础安全头。  
**修复**：安装 `helmet`。

```bash
npm install helmet
```
```js
const helmet = require('helmet');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"], // 纯内联脚本前端暂时保留
      imgSrc: ["'self'", "data:", "blob:"],
      styleSrc: ["'self'", "'unsafe-inline'"],
    }
  }
}));
```

### 2.6 缺乏请求频率限制

**风险**：验证码接口、发帖接口可被暴力刷取。  
**修复**：安装 `express-rate-limit`。

```bash
npm install express-rate-limit
```
```js
const rateLimit = require('express-rate-limit');
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { code: 429, msg: '请求过于频繁' } });
app.use('/api/auth/', authLimiter);
```

---

## 三、P1 — 架构与代码质量（本周内完成）

### 3.1 单文件 3,282 行：必须拆分

当前 `app.js` 是巨型单体文件，维护成本极高。建议按以下结构拆分：

```
server/
├── index.js              # 启动入口（< 50 行）
├── app.js                # Express 实例创建 + 全局中间件
├── config/
│   ├── env.js            # 环境变量统一读取与校验
│   ├── db.js             # MySQL 连接池 + db 封装
│   ├── smtp.js           # 邮件客户端
│   └── ai.js             # 外部 AI 配置
├── routes/
│   ├── auth.js           # 认证相关（邮箱、学生证、token）
│   ├── shares.js         # 学生分享（发帖、评论、点赞、举报）
│   ├── majors.js         # 专业/院校/新闻 CRUD
│   ├── admin.js          # 管理后台接口
│   └── ai-query.js       # 智能查询（Stepfun）
├── middleware/
│   ├── auth.js           # parseAuthToken / getTokenFromRequest
│   ├── admin.js          # verifyAdminLegacy / checkAdminAuth
│   ├── error.js          # 全局错误处理
│   └── rateLimit.js      # 限流配置
├── services/
│   ├── deepseek.js       # DeepSeek 调用 + 429 重试
│   ├── stepfun.js        # Stepfun 智能查询（stepfun-ai.js 迁移）
│   ├── bailian.js        # 百炼审核 + 鉴伪
│   └── aliyun-green.js   # 阿里云内容安全
├── utils/
│   ├── datetime.js       # toMySQLDateTime / toTinyInt
│   ├── validators.js     # 输入校验
│   └── crypto.js         # token 生成
└── models/               # 可选：ORM 或查询封装层
```

### 3.2 路由重复定义（/admin/... 与 /api/admin/...）

**位置**：多处出现（如 `app.js:2956-3025` 的 `ai-add-program`）。  
**修复**：使用 Express Router 前缀统一挂载，删除重复代码。

```js
// routes/admin.js
const router = require('express').Router();
router.post('/ai-add-program', verifyAdmin, handler);
// ...

// app.js
app.use('/admin', adminRouter);
app.use('/api/admin', adminRouter); // 复用同一个 router
```

### 3.3 缺乏统一输入校验

当前仅少量字段有 `trim()`，没有长度限制、类型校验、XSS 过滤。  
**修复**：使用 `express-validator` 或手写校验函数。

```js
function validateShareBody(body) {
  const title = String(body.title || '').trim();
  const content = String(body.content || '').trim();
  if (!title || title.length > 120) throw new Error('标题长度 1-120 字');
  if (!content || content.length > 5000) throw new Error('内容长度 1-5000 字');
  return { title, content };
}
```

### 3.4 回调地狱与错误处理不一致

大量 `db.run(..., callback)` 回调嵌套，部分接口混用 `async/await` 和回调。  
**修复**：将 `db.run` / `db.all` / `db.get` 改为 Promise 封装。

```js
function dbRun(sql, params) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}
```

### 3.5 缺乏统一响应格式

部分接口 `res.send({ code, msg })`，部分 `res.json({ code, msg })`，部分 `res.status(403).send('无权限')`（字符串）。  
**修复**：统一响应中间件。

```js
function success(res, data, msg = 'OK') {
  res.json({ code: 200, msg, data });
}
function fail(res, code, msg, status = 400) {
  res.status(status).json({ code, msg });
}
```

### 3.6 前端：4 个巨型 HTML 文件无组件复用

**位置**：`student-shares.html`（2,193 行）、`admin.html`（1,887 行）、`major-info.html`（44,775 字节）。  
**修复**：短期可提取公共 CSS 和 JS 到 `common.css` / `common.js`；中期建议迁移到 Vue/React 或至少使用模板引擎（如 EJS）做组件复用。

### 3.7 未使用的数据库：SQLite 残留

`package.json` 依赖了 `mysql2`，但 `README` 仍写 "SQLite3"；`Dockerfile` 安装了 `python3 make g++` 是为了 `sqlite3` 原生模块编译。  
**修复**：确认 SQLite 完全弃用后，删除 `sqlite3` 依赖，精简 Dockerfile。

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --registry=https://registry.npmmirror.com
COPY . .
EXPOSE 3000
CMD ["node", "server/index.js"]
```

---

## 四、P2 — 性能与数据库（本月内完成）

### 4.1 N+1 查询问题严重

**位置**：`app.js:1563-1564` 学生分享列表，每条帖子都单独子查询点赞数：
```js
(SELECT COUNT(*) FROM share_likes sl WHERE sl.share_id = s.id) AS like_count
```
**问题**：MySQL 会对每行执行子查询，100条帖子 = 100次子查询。  
**修复**：使用 `JOIN` 或应用层聚合。

```sql
SELECT s.id, s.title, ..., COUNT(sl.share_id) AS like_count
FROM student_shares s
LEFT JOIN share_likes sl ON sl.share_id = s.id
WHERE ...
GROUP BY s.id
```

### 4.2 缺少关键数据库索引

当前表结构没有针对高频查询的索引。建议添加：

```sql
-- 认证token查询（每次请求都查）
ALTER TABLE verified_users ADD INDEX idx_auth_token (auth_token);

-- 学生分享列表过滤（status + delete_after + upload_time）
ALTER TABLE student_shares ADD INDEX idx_shares_list (status, delete_after, upload_time);
ALTER TABLE student_shares ADD INDEX idx_shares_school (school, status);
ALTER TABLE student_shares ADD INDEX idx_shares_major (major, status);

-- 评论查询
ALTER TABLE share_comments ADD INDEX idx_comments_share (share_id, status, created_at);

-- 举报统计
ALTER TABLE share_reports ADD INDEX idx_reports_share (share_id);
ALTER TABLE comment_reports ADD INDEX idx_reports_comment (comment_id);

-- 搜索
ALTER TABLE major_overviews ADD FULLTEXT INDEX ft_major_name (major_name); -- MySQL 8.0+
```

### 4.3 图片 base64 存储在数据库中

`images` 字段存 base64 字符串，`LONGTEXT` 类型，单张图几 MB，严重影响列表查询速度。  
**修复方案**（渐进式）：

1. **短期**：图片上传至 OSS/S3/MinIO，数据库存储 URL。
2. **中期**：限制单帖图片数量和大小（最多3张，每张≤2MB）。
3. **长期**：前端压缩 + WebP 格式 + CDN 加速。

### 4.4 关键词缓存并发竞态

`loadKeywordCategories()` 中缓存 10 分钟，但多个并发请求同时命中过期缓存时，会同时发起多次 MySQL 查询。  
**修复**：使用单例 Promise 锁。

```js
let keywordCachePromise = null;
async function loadKeywordCategories() {
  if (keywordCategoriesCache && Date.now() - keywordCategoriesCacheTime < TTL) {
    return keywordCategoriesCache;
  }
  if (!keywordCachePromise) {
    keywordCachePromise = _fetchFromDB().finally(() => { keywordCachePromise = null; });
  }
  return keywordCachePromise;
}
```

### 4.5 智能查询超时 90 秒

`STEPFUN_TIMEOUT_MS = 90000`，用户等待 1.5 分钟，体验极差。  
**修复**：改为流式响应（SSE）或快速返回 + 后台轮询。

```js
// 方案A：流式输出（SSE）
res.setHeader('Content-Type', 'text/event-stream');
// 逐字输出 AI 回复

// 方案B：快速返回任务ID，前端轮询
res.json({ code: 200, taskId, status: 'processing' });
// 前端每 3 秒 GET /api/tasks/:taskId
```

### 4.6 `ORDER BY RAND()` 性能差

**位置**：`app.js:1590`、`app.js:3207`  
**问题**：MySQL `ORDER BY RAND()` 在数据量大时全表扫描+排序，性能极差。  
**修复**：使用主键范围随机抽样。

```sql
-- 替代方案：先取随机ID，再查详情
SELECT id FROM student_shares WHERE status='approved' ORDER BY id DESC LIMIT 1000;
-- 程序中随机选 N 个 id，再 IN 查询
```

---

## 五、P3 — 部署与运维（本月内完成）

### 5.1 混合架构复杂：Vercel + ECS + 魔搭创空间

当前架构：
- Vercel 托管静态 HTML + 代理 API → ECS `115.29.233.160`
- 魔搭创空间 Docker 部署
- 后端数据库在远程服务器

**问题**：Vercel 是 Serverless，每次请求都回源到 ECS，延迟高；路径重写配置复杂。  
**建议**：统一架构，二选一：

- **方案A（推荐）**：ECS/云服务器独占部署（前后端一体），Vercel 只用于 CDN 加速静态资源。
- **方案B**：魔搭创空间 Docker 部署完整应用，Vercel 只做域名跳转。

### 5.2 缺少健康检查接口

**修复**：添加 `/health`。

```js
app.get('/health', async (req, res) => {
  const dbOk = mysqlPool ? await mysqlPool.query('SELECT 1').then(() => true).catch(() => false) : false;
  res.json({ status: dbOk ? 'ok' : 'degraded', db: dbOk, time: new Date().toISOString() });
});
```

### 5.3 缺少日志分级

当前大量使用 `console.log`/`console.error`，生产环境无法区分日志级别。  
**修复**：使用 `winston` 或 `pino`，区分 `info`/`warn`/`error`，写入文件并轮转。

```bash
npm install pino pino-pretty
```

### 5.4 环境变量管理混乱

不同部署环境（本地、Vercel、ECS、魔搭）需要不同配置，当前全靠代码判断 `process.env.VERCEL`。  
**修复**：使用 `dotenv` + 环境文件分层。

```
.env.local      # 本地开发
.env.production # 生产环境（不提交）
.env.example    # 示例模板（提交）
```

### 5.5 缺少数据库备份自动化

当前依赖手动访问 `/admin/backup/download-db` 下载。MySQL 环境下该接口已失效。  
**修复**：配置 `mysqldump` 定时任务（crontab）或云数据库自动备份。

---

## 六、P4 — 产品体验（持续优化）

### 6.1 Token 有效期 10 年过长

`TOKEN_EXPIRY_MS = 10 * 365 * 24 * 60 * 60 * 1000`  
**修复**：改为 90 天，配合自动续期（每次活跃请求刷新 `token_expires_at`）。

### 6.2 举报阈值 50 次过高

对于校园小平台，50 次举报意味着恶意内容可能已传播很久。  
**修复**：改为 5 次，或按「举报数 / 浏览数」比例触发。

### 6.3 AI 数据录入可靠性低

DeepSeek 检索学校专业信息并写入数据库，但 AI 会幻觉（编造不存在的信息）。`confirmSchoolOffersMajor` 虽有校验，但本身也是 AI 调用。  
**修复**：
- 数据录入必须人工确认，AI 仅作「候选建议」。
- 或对接真实数据源（教育部阳光高考 API）。
- 录入后标记 `data_source = 'ai_assisted'`，定期人工抽检。

### 6.4 游客点赞容易被刷

`guestId` 来自前端参数，可随意修改。  
**修复**：游客点赞使用 IP + User-Agent 哈希，或限制设备指纹。

---

## 七、快速行动清单

按以下顺序执行，每项约 1-2 天：

### 第一周（安全加固）
- [ ] 1. `ADMIN_PASSWORD` 和 `MYSQL_HOST` 改为强制环境变量，移出硬编码
- [ ] 2. `migrate.js` 密码改为环境变量读取
- [ ] 3. 安装 `helmet` + `express-rate-limit`
- [ ] 4. 限制 CORS 白名单
- [ ] 5. 添加 `/health` 健康检查

### 第二周（架构拆分）
- [ ] 6. 创建 `server/` 目录结构，将 app.js 拆分为 routes/services/middleware
- [ ] 7. 统一 `/admin` 和 `/api/admin` 路由挂载
- [ ] 8. 封装 Promise 版 db 工具，统一错误处理和响应格式
- [ ] 9. 精简 Dockerfile（去掉 sqlite3 编译依赖）

### 第三周（性能优化）
- [ ] 10. 添加数据库索引（见 4.2 清单）
- [ ] 11. 修复 N+1 查询（点赞数、评论数改用 JOIN 聚合）
- [ ] 12. 限制 `images` 大小，引入 OSS 上传方案
- [ ] 13. 优化 `ORDER BY RAND()` 和 `loadKeywordCategories` 并发锁

### 第四周（部署与监控）
- [ ] 14. 统一部署架构（建议 ECS 独占部署）
- [ ] 15. 引入 `pino` 日志分级，配置日志轮转
- [ ] 16. 配置 `.env` 分层管理
- [ ] 17. 配置 MySQL 自动备份（云数据库或 crontab）

---

## 八、长期演进路线

| 阶段 | 目标 | 技术选型 |
|------|------|----------|
| **1.0 稳定** | 安全 + 性能达标 | 当前技术栈优化 |
| **2.0 工程化** | 前后端分离、可维护 | Vue 3 + Vite + TypeScript |
| **3.0 数据层** | 对接真实招生数据 | 阳光高考 API / 教育部数据 |
| **4.0 智能化** | 减少 AI 幻觉、提升准确度 | 知识库 RAG + 本地向量库（如 DuckDB + 嵌入） |

---

*如有需要，我可以针对上述任何一项给出具体代码实现（如拆分 app.js 的模块化方案、数据库索引迁移脚本、Dockerfile 优化等）。*

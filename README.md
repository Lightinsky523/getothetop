---
# 创空间部署遵循官方文档：https://www.modelscope.cn/docs/studios/quick-create
domain:
tags:
- 志愿填报
- 高考
datasets:
  train:
models:
license: Apache License 2.0
---

# 新高考志愿填报及分流指导系统

> 本文档为 **Markdown** 格式，可在 GitHub、魔搭、VS Code 等支持 Markdown 的平台上直接预览。

基于 **Node.js** + **SQLite** 的 Web 应用，提供志愿填报参考、学校与专业信息查询、在读生经历分享与评论，支持邮箱/学生证认证、举报与人工审核，可部署于魔搭创空间或本地运行。

---

## 目录

- [功能详解](#功能详解)
- [技术栈与依赖](#技术栈与依赖)
- [项目结构](#项目结构)
- [本地运行](#本地运行)
- [环境变量详解](#环境变量详解)
- [魔搭创空间部署](#魔搭创空间部署)
- [数据持久化与备份](#数据持久化与备份)
- [管理后台详解](#管理后台详解)
- [API 接口参考](#api-接口参考)
- [数据库表结构](#数据库表结构)
- [认证与鉴权说明](#认证与鉴权说明)
- [常见问题](#常见问题)
- [许可证](#许可证)

---

## 功能详解

### 1. 志愿填报参考（首页 index.html）

- **智能查询**：用户输入问题后，系统从已发布的学生分享中筛选相关帖子，并调用阿里云百炼（千问）应用 API 结合参考信息生成回答；需配置 `BAILIAN_API_KEY` 与 `BAILIAN_APP_ID`。
- **选科与省份**：可填写选科（首选/再选）与省份，作为上下文参与智能回答。
- **用户画像摘要**：可填写简要个人信息，用于个性化回答。
- **数据来源**：专业概览、开设院校、专业动态等来自管理后台录入或 AI 检索录入，与专业院校信息概览页共用。

### 2. 专业院校信息概览（major-info.html）

- 按专业浏览**专业概览**（名称、类别、学位类型、学制、简介等）。
- 查看各专业下的**开设院校**（院校名称、层次、地区、专业特色、课程、学费、招生要求等）。
- 查看**专业动态/趣闻**（标题、来源、发布日期、是否热门）。
- 数据由管理后台「专业概览管理」「开设院校管理」「专业动态管理」及「数据检索录入」维护。

### 3. 学生分享（student-shares.html）

- **发帖**：仅**在读生**可发帖；须先完成**在读生认证**（邮箱或学生证），且只能发布**认证学校**相关经历；发帖时可填学校、专业、年级、标题、正文、标签、图片（base64）；每条帖子经阿里云百炼内容审核，违规拒绝、存疑则进入待人工审核。
- **评论**：所有人可评论，无需认证；**已认证用户**的评论展示「认证学校 · 昵称」，**未认证**展示「游客」；评论时 token 通过请求体与 URL 参数双传，以兼容创空间等环境下 body 未解析的情况。
- **举报**：所有人可举报帖子或评论；同一帖子/评论被举报次数超过 50 次后自动进入后台「分享内容审核」，管理员可删除或通过。
- **删除**：已认证用户可**删除自己发布的帖子**（软删，帖子 status 置为 deleted，并删除其下评论）和**删除自己发布的评论**（硬删）；删除前需二次确认。
- **认证方式**：
  - **邮箱认证**：使用 .edu / .edu.cn 邮箱，填写验证码与学校、昵称；验证码可通过 SMTP 发送或未配置时在接口响应中返回。
  - **学生证认证**：上传学生证图片；若配置阿里云内容安全则先做鉴伪，通过则直接写入 verified_users，存疑则进入「待人工审核」，管理员在后台通过或拒绝后写入 verified_users 并返回 token。
- **认证状态**：认证通过后获得长期有效的 `authToken`（约 10 年），前端保存在 localStorage；可「退出认证」，退出后发帖/删除需重新认证，评论仍可发但显示为游客。

### 4. 管理后台（admin.html）

- 需输入**管理员密码**登录（密码在服务端 `app.js` 中配置，部署前请修改）。
- 功能模块见 [管理后台详解](#管理后台详解)。

---

## 技术栈与依赖

| 类型     | 技术/依赖 |
|----------|------------|
| 运行时   | Node.js（建议 18+） |
| 后端框架 | Express 4.x |
| 数据库   | SQLite3（单文件 `study_experience.db`） |
| 跨域     | cors |
| 请求体   | express.json（limit 15mb）、express.urlencoded（15mb） |
| 可选 HTTP | node-fetch（智能查询、审核等请求） |
| 可选邮件 | nodemailer（验证码发送） |

- **前端**：纯静态 HTML + CSS + JavaScript，无构建工具；页面包括 `index.html`、`major-info.html`、`student-shares.html`、`admin.html`。
- **可选外部服务**：阿里云百炼（智能查询 + 发帖内容审核）、DeepSeek（邮箱后缀识别、专业数据录入）、阿里云内容安全（学生证图片鉴伪）、SMTP（邮件验证码）。

---

## 项目结构

```
.
├── app.js                 # 后端入口：Express 路由、SQLite、认证、审核逻辑
├── package.json           # Node 依赖与 start 脚本
├── Dockerfile             # 魔搭创空间 Docker 镜像（Node 18，端口 3000）
├── ms_deploy.json         # 魔搭创空间部署配置（sdk_type: docker, port: 3000）
├── README.md
├── index.html             # 志愿填报参考首页（智能查询等）
├── major-info.html        # 专业院校信息概览
├── student-shares.html    # 学生分享（发帖、评论、举报、自删）
├── admin.html             # 管理后台（专业/院校/新闻/学生证/分享审核/数据录入）
├── index_old.html         # 旧版首页（如有保留）
├── test-submit-share-auth.js  # 发帖认证测试脚本（可选）
└── requirements.txt       # 若存在则为 Python 相关（本应用以 Node 为主）
```

- **数据目录**：由环境变量 `DATA_DIR` 或 `resolveDataDir()` 决定，默认本地为 `data`（若存在），创空间默认 `/home/user/app/data`；SQLite 数据库路径为 `{DATA_DIR}/study_experience.db`。

---

## 本地运行

### 前置要求

- 已安装 **Node.js 18+** 和 **npm**。
- 如需智能查询、邮件验证码、学生证鉴伪等，请先配置相应环境变量（见 [环境变量详解](#环境变量详解)）。

### 步骤

```bash
# 1. 克隆仓库
git clone https://www.modelscope.cn/studios/taoyao0498/Guidance_on_Application_and_streaming.git
cd Guidance_on_Application_and_streaming

# 2. 安装依赖
npm install

# 3. 启动服务（默认端口 3000）
npm start
# 或指定端口
PORT=3000 node app.js
```

- 浏览器访问：**http://localhost:3000**（或你设置的端口）。
- 数据目录：未设置 `DATA_DIR` 时，在创空间默认使用 `/home/user/app/data`；本地通常为当前目录下自动创建的 `data`（具体以 `resolveDataDir()` 逻辑为准，见 `app.js`）。

### 首次使用建议

1. 打开 **admin.html**，使用管理员密码登录（密码在 `app.js` 中配置，请先修改为强密码）。
2. 在「专业概览管理」「开设院校管理」中添加少量数据，或在「数据检索录入」中通过 DeepSeek 检索添加（需配置 `DEEPSEEK_API_KEY`）。
3. 在 **student-shares.html** 进行邮箱或学生证认证后发帖、评论，测试举报与自删。

---

## 环境变量详解

| 变量名 | 必填 | 说明 | 示例 |
|--------|------|------|------|
| `PORT` | 否 | 服务监听端口 | `3000`（默认） |
| `DATA_DIR` | 否 | 数据目录绝对路径，SQLite 库与上传等存放于此 | `/home/user/app/data` |
| `DATASET_MOUNT_PATH` | 否 | 创空间关联数据集后的挂载路径，优先于默认 DATA_DIR | 以创空间文档为准 |
| `AUTO_CLONE_DATASET` | 否 | 自动克隆的数据集 ID，用于持久化；克隆目录由 `DATASET_LOCAL_PATH` 指定 | `taoyao0498/Data_for_GAS` |
| `DATASET_LOCAL_PATH` | 否 | 与 `AUTO_CLONE_DATASET` 配合，克隆到的本地路径 | `/home/user/app/Data_for_GAS` |
| `BAILIAN_API_KEY` | 智能查询/发帖审核需 | 阿里云百炼 API Key | `sk-xxx` |
| `BAILIAN_APP_ID` | 智能查询/发帖审核需 | 阿里云百炼应用 ID | `1a5d7eb76b1f4c86961d372c6d134b9b` |
| `DIRECT_AI_KEY` | 可选 | 与 BAILIAN 二选一，作为百炼 Key 的别名 | 同 BAILIAN_API_KEY |
| `DEEPSEEK_API_KEY` | 数据检索录入/邮箱识别需 | DeepSeek API Key | `sk-xxx` |
| `DEEPSEEK_KEY` | 可选 | DeepSeek Key 的别名 | 同 DEEPSEEK_API_KEY |
| `DEEPSEEK_API_URL` | 否 | DeepSeek 接口地址 | `https://api.deepseek.com/v1/chat/completions` |
| `DEEPSEEK_MODEL` | 否 | 模型名 | `deepseek-chat` |
| `SMTP_HOST` | 邮件验证码需 | SMTP 服务器 | `smtp.qq.com` |
| `SMTP_PORT` | 否 | SMTP 端口 | `587` 或 `465` |
| `SMTP_USER` | 邮件需 | SMTP 用户名 | 邮箱地址 |
| `SMTP_PASS` | 邮件需 | SMTP 密码或授权码 | 字符串 |
| `SMTP_FROM` | 否 | 发件人地址，缺省用 SMTP_USER | 同 SMTP_USER |
| `ALIYUN_ACCESS_KEY_ID` | 学生证鉴伪需 | 阿里云 AccessKey ID | 或使用 `ALIBABA_CLOUD_ACCESS_KEY_ID` |
| `ALIYUN_ACCESS_KEY_SECRET` | 学生证鉴伪需 | 阿里云 AccessKey Secret | 或使用 `ALIBABA_CLOUD_ACCESS_KEY_SECRET` |
| `ALIYUN_GREEN_REGION` | 否 | 内容安全地域 | `cn-shanghai`（默认） |

- **管理员密码**：在 `app.js` 中通过常量配置（如 `ADMIN_PASSWORD`），**未**通过环境变量暴露；部署前请在代码中改为强密码并勿提交到公开仓库。

---

## 魔搭创空间部署

### 部署方式概览

- **类型**：Docker（`ms_deploy.json` 中 `sdk_type: "docker"`）。
- **入口**：`Dockerfile` 中 `ENTRYPOINT ["node", "app.js"]`。
- **端口**：服务监听 `0.0.0.0:3000`，与 `ms_deploy.json` 的 `port: 3000` 一致。
- **资源**：`ms_deploy.json` 中可配置 `resource_configuration`（如 `platform/2v-cpu-16g-mem`）。

### 部署步骤概要

1. 在魔搭创建创空间，选择「从代码仓库部署」或上传本仓库。
2. 仓库根目录需包含：`Dockerfile`、`ms_deploy.json`、`app.js`、`package.json` 及前端 HTML 等。
3. 创空间构建时会执行 `npm install` 并启动 `node app.js`。
4. 在创空间「设置」中配置所需环境变量（如 `DATA_DIR`、`BAILIAN_*`、`DEEPSEEK_*`、`SMTP_*`、`ALIYUN_*` 等）。
5. 发布/运行后，通过创空间提供的访问地址打开应用（例如 `https://www.modelscope.cn/studios/xxx/xxx`）。

### 数据目录与持久化

- 创空间默认数据目录为 `/home/user/app/data`，**重启或重新从基础镜像构建时可能被清空**。
- 持久化建议见 [数据持久化与备份](#数据持久化与备份)。
- 官方文档：[快速创建并部署](https://www.modelscope.cn/docs/studios/quick-create)。

---

## 数据持久化与备份

### 方式一：关联数据集并挂载

1. 在魔搭创建数据集（可为空仓库），例如 `taoyao0498/Data_for_GAS`。
2. 在创空间「配置」中关联该数据集，确认挂载路径（以官方文档或运行日志为准）。
3. 在环境变量中设置 `DATA_DIR=挂载路径` 或 `DATASET_MOUNT_PATH=挂载路径`，重启应用；数据库将写入该路径，随数据集持久保存。

### 方式二：自动克隆数据集到容器内

1. 设置环境变量 `AUTO_CLONE_DATASET=taoyao0498/Data_for_GAS`（替换为你的数据集 ID）。
2. 可选设置 `DATASET_LOCAL_PATH=/home/user/app/Data_for_GAS`（克隆目标路径）。
3. 应用启动时会尝试 `git clone` 该数据集；若容器内无 git 或网络受限，可能失败，需改用方式一或方式三。

### 方式三：下载数据库到本机备份

- 在浏览器访问（将 `你的创空间地址`、`管理员密码` 替换为实际值）：  
  **https://你的创空间地址/admin/backup/download-db?password=管理员密码**
- 会下载当前实例的 `study_experience.db` 文件；建议定期备份，以便在清空后恢复或迁移。

### 恢复数据

- 若使用数据集挂载：新环境中再次关联同一数据集并设置相同 `DATA_DIR`/`DATASET_MOUNT_PATH` 即可。
- 若仅有本机备份的 `study_experience.db`：将文件放回 `DATA_DIR` 下并命名为 `study_experience.db`，重启应用即可。

---

## 管理后台详解

- **入口**：打开 **admin.html**（例如 `http://localhost:3000/admin.html`），输入管理员密码登录。
- **密码**：在服务端 `app.js` 中配置，请自行修改并妥善保管。

### 功能模块

1. **专业概览管理**  
   管理专业代码、名称、所属类别、学位类型、学制、简介等；支持搜索、添加、编辑、删除。

2. **开设院校管理**  
   按专业管理开设院校；字段含院校名称、层次、地区、专业特色、课程、学费、招生要求、联系方式等；依赖专业概览数据。

3. **专业动态管理**  
   按专业管理动态/趣闻；字段含标题、来源、发布日期、是否热门等。

4. **数据检索录入**  
   - **单条检索添加**：输入院校名称 + 专业名称，调用 DeepSeek 等检索并写入专业概览与开设院校（专业不存在时自动创建）。
   - **批量检索添加**：输入院校名称 + 多行专业名称，批量检索并添加。
   - **按学校添加所有招生专业**：输入院校名称，检索该校招生专业并逐条创建。  
   需配置 `DEEPSEEK_API_KEY` 才能使用。

5. **学生证审核**  
   展示状态为「待人工审核」的学生证提交记录；可查看图片、通过或拒绝；通过后写入 `verified_users` 并生成 token，用户端轮询后可拿到 token 完成认证。

6. **分享内容审核**  
   展示因 AI 无法判定或举报次数过多而进入待审的帖子；可查看详情、通过（公开展示）或删除（软删）；被举报过多的评论在「被举报评论」接口中处理（见 API）。

### 管理员接口速查（均需 password）

- 待审学生证列表：`GET /admin/student-id-pending?password=xxx`
- 学生证详情/图片：`GET /admin/student-id-pending/:id?password=xxx`
- 学生证通过/拒绝：`POST /admin/student-id-review`，body：`{ password, id, action: 'approve'|'reject' }`
- 被举报帖子列表：`GET /admin/reported-shares?password=xxx`
- 删除帖子：`POST /admin/student-shares/:id/delete`，body/query：`password`
- 通过待审帖子：`POST /admin/student-shares/:id/approve`，body/query：`password`
- 被举报评论列表：`GET /admin/reported-comments?password=xxx`
- 删除评论：`POST /admin/comments/:id/delete`，body/query：`password`
- 下载数据库备份：`GET /admin/backup/download-db?password=xxx`（返回 `study_experience.db` 文件）

---

## API 接口参考

以下为主要接口；请求体为 JSON 时需设 `Content-Type: application/json`。认证相关接口可从 body、query、Header（`X-Auth-Token` 或 `Authorization: Bearer <token>`）读取 `authToken`。

### 公开/前端

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/`、`/index.html` | 志愿填报首页 |
| GET | `/major-info.html` | 专业院校概览页 |
| GET | `/student-shares.html` | 学生分享页 |
| GET | `/admin.html` | 管理后台页 |
| GET | `/api/schools` | 学校列表 |
| GET | `/api/schools/:schoolName/majors` | 某校专业列表 |
| GET | `/api/majors` | 专业概览列表 |
| GET | `/api/majors/:id` | 专业详情 |
| GET | `/api/majors/search`、POST `/api/majors/search` | 专业搜索 |
| GET | `/api/news` | 专业动态列表 |
| GET | `/api/news/:id` | 动态详情 |
| GET | `/api/student-shares` | 学生分享列表（已通过审核），支持 query：school, major, keyword |
| POST | `/api/student-shares` | 发布分享（需认证，body：school, major, grade, title, content, tags, images 等） |
| DELETE | `/api/student-shares/:id` | 删除本人帖子（需认证，body/query/header 带 authToken） |
| GET | `/api/student-shares/:id/comments` | 某帖评论列表 |
| POST | `/api/student-shares/:id/comments` | 发表评论（body：content；可选 authToken；建议 URL 同时带 ?authToken= 以兼容创空间） |
| DELETE | `/api/student-shares/:shareId/comments/:commentId` | 删除本人评论（需认证） |
| POST | `/api/student-shares/:id/report` | 举报帖子 |
| POST | `/api/student-shares/:shareId/comments/:commentId/report` | 举报评论 |
| POST | `/ai-query` | 智能查询（body：prompt；可选 profileSummary, isXuanke, xuankeContext） |
| POST | `/api/auth/send-code` | 发送邮箱验证码（body：email） |
| POST | `/api/auth/verify` | 邮箱验证码认证（body：email, code, school_name, nickname 等） |
| POST | `/api/auth/student-id` | 提交学生证认证（body：school_name, image_data, nickname 等） |
| GET | `/api/auth/student-id/status` | 轮询学生证审核结果（query：submissionId） |
| GET | `/api/auth/me` | 当前认证用户信息（query/header：authToken） |

### 管理端（均需 password）

- 见 [管理后台详解](#管理后台详解) 中的「管理员接口速查」。

---

## 数据库表结构

- 库文件：`{DATA_DIR}/study_experience.db`。
- 主要表（名称与用途）：

| 表名 | 用途 |
|------|------|
| `user_uploads` | 早期用户提交的学校/专业/经历等 |
| `student_shares` | 学生分享帖子（学校、专业、年级、标题、正文、标签、图片、status、author_nickname、upload_time） |
| `share_comments` | 帖子评论（share_id, user_email, school_name, nickname, content, status, created_at） |
| `share_reports` | 帖子举报记录 |
| `comment_reports` | 评论举报记录 |
| `verification_codes` | 邮箱验证码（email, code, school_name, expires_at） |
| `verified_users` | 已认证用户（email, school_name, auth_type, auth_token, token_expires_at, nickname） |
| `student_id_verifications` | 学生证认证提交（school_name, image_data, status, auth_token, nickname 等） |
| `schools` | 学校信息 |
| `school_major_programs` | 旧版学校-专业关联（部分逻辑可能仍用） |
| `major_overviews` | 专业概览 |
| `school_programs` | 专业开设院校等信息 |
| `major_news` | 专业动态/趣闻 |

- 表结构以 `app.js` 内 `CREATE TABLE IF NOT EXISTS` 及后续 `ALTER TABLE` 为准；部分表有 `status` 字段用于审核（如 approved / pending_review / deleted）。

---

## 认证与鉴权说明

- **认证结果**：通过邮箱验证或学生证审核后，在 `verified_users` 中写入一条记录，并生成长期有效的 `auth_token`（约 10 年）；前端将返回的 token 存入 localStorage，后续请求在 body、query 或 Header 中携带。
- **Token 读取顺序**：`getTokenFromRequest(req)` 依次从 `body.authToken` / `body.auth_token`、`query.authToken`、Header `X-Auth-Token` 或 `Authorization: Bearer <token>` 读取。
- **发帖/删帖/删评论**：仅允许已认证用户，且删除时校验当前 token 对应用户与帖子/评论的作者（学校+昵称）一致。
- **评论**：不强制认证；若带有效 token 则评论展示「学校 · 昵称」，否则展示「游客」；建议前端发表评论时同时传 body 与 URL 参数中的 authToken，以兼容创空间等环境。

---

## 常见问题

1. **评论始终显示「游客」**  
   确认前端在发表评论时是否携带 authToken（请求体 + URL 参数 `?authToken=xxx` 双传）；确认 token 未过期且在 `verified_users` 中存在。

2. **智能查询报错或超时**  
   检查 `BAILIAN_API_KEY`、`BAILIAN_APP_ID` 是否配置；若仍超时，可考虑减少上下文长度或联系百炼侧限流策略。

3. **学生证一直待审核**  
   若未配置阿里云内容安全，学生证会走人工审核；管理员需在 admin「学生证审核」中通过或拒绝。

4. **创空间重启后数据丢失**  
   未将 `DATA_DIR` 指向持久化存储（如关联数据集挂载路径）时，容器内数据会丢失；请按 [数据持久化与备份](#数据持久化与备份) 配置或定期用 download-db 备份。

5. **管理员密码忘记或需修改**  
   在 `app.js` 中搜索并修改管理员密码常量，重启服务后生效。

---

## 许可证

Apache License 2.0

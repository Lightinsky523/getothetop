---
# 创空间部署遵循官方文档：https://www.modelscope.cn/docs/studios/quick-create
domain: #领域：cv/nlp/audio/multi-modal/AutoML
# - nlp
tags: #自定义标签
- 志愿填报
- 高考

datasets: #关联数据集（可选，用于数据持久化）
  train:
  #- taoyao0498/Data_for_GAS
models: #关联模型
# （本创空间为 Web 应用，不关联模型）

## 部署方式：Docker（Node.js）。配置见根目录 ms_deploy.json，入口由 Dockerfile 指定（node app.js），端口 7860。
license: Apache License 2.0
---
#### 魔搭创空间部署说明（按 [快速创建并部署](https://www.modelscope.cn/docs/studios/quick-create) 配置）
- **部署类型**：Docker（`ms_deploy.json` 中 `sdk_type: docker`），根目录需有 `Dockerfile`，服务监听 **0.0.0.0:7860**。
- **端口**：7860（已暴露，与 `ms_deploy.json` 中 `port: 7860` 一致）
- 数据目录：`DATA_DIR` 默认为 `/home/user/app/data`（重启「从基础镜像开始」时会被清空）
- 环境变量（可选）：
  - `DEEPSEEK_API_KEY` DeepSeek API Key（用于**邮箱后缀→学校识别**与**专业数据录入**：单条/批量/按学校添加；未配置时邮箱识别仅用内置表，数据录入需配置后才能使用）
  - `SMTP_HOST`、`SMTP_PORT`、`SMTP_USER`、`SMTP_PASS` 邮件配置（未配置时验证码在响应中返回，便于测试）
  - `ALIYUN_ACCESS_KEY_ID`、`ALIYUN_ACCESS_KEY_SECRET` 阿里云内容安全（学生证鉴伪；未配置时一律走人工审核）。也支持 `ALIBABA_CLOUD_ACCESS_KEY_ID` / `ALIBABA_CLOUD_ACCESS_KEY_SECRET`。RAM 用户需授权 `AliyunYundunGreenWebFullAccess`。

#### 学生分享认证与人工审核
- 认证方式：**在读生认证**（邮箱认证：.edu/.edu.cn + 验证码；或学生证认证：上传学生证图片）与 **高考生认证**（仅填昵称即可）。认证时需填写 **昵称**（用于展示）。认证后可 **退出认证**，退出后需重新认证才能发帖/评论。
- **在读生**：只能在认证学校下发帖，帖子展示学校与专业。**高考生**：仅可评论，不可发帖。
- **举报与审核**：帖子和评论均有「举报」选项；某帖子举报次数超过 50 次后自动进入后台审核（status=pending_review），管理员可删帖。接口：<code>GET /admin/reported-shares?password=管理员密码</code> 查看待审帖子，<code>POST /admin/student-shares/:id/delete</code> 传 <code>password</code> 删帖。
- 学生证认证：若配置了阿里云内容安全则先走图片鉴伪，存疑或未配置时转 **人工审核**。管理员审核接口：<code>GET /admin/student-id-pending?password=管理员密码</code> 获取待审列表，<code>GET /admin/student-id-pending/:id?password=xxx</code> 查看图片，<code>POST /admin/student-id-review</code> 传 <code>password, id, action=approve|reject</code> 通过或拒绝。

#### 数据备份到数据集（防止重启丢失，一键存储）
- **数据集**：[taoyao0498/Data_for_GAS](https://www.modelscope.cn/datasets/taoyao0498/Data_for_GAS)
- **原理**：创空间重启会清空容器内文件；魔搭「数据集」在平台侧持久保存。应用会把数据库复制到已 clone 的数据集目录并自动执行 `git add / commit / push`，无需找终端。

**方式一：能用创空间终端时**
- 在创空间终端执行一次：<code>git clone https://www.modelscope.cn/datasets/taoyao0498/Data_for_GAS.git /home/user/app/Data_for_GAS</code>
- 管理后台 →「数据备份」→ 路径已预填为 <code>/home/user/app/Data_for_GAS</code> → 点击「一键存储到数据集」。
- 恢复：新环境中再次执行上述 clone，并设置环境变量 <code>DATA_DIR=/home/user/app/Data_for_GAS</code> 后启动应用。

**方式二：无法使用创空间终端时**
- 在创空间 **设置 / 环境变量** 里添加：<code>AUTO_CLONE_DATASET=taoyao0498/Data_for_GAS</code>（请先到魔搭创建该数据集，可为空仓库）。
- 保存并重新启动应用。应用会尝试在**首次启动时自动克隆**该数据集；若容器内无 git 或网络限制导致失败，请改用下方「若自动克隆无效」的作法。

**若自动克隆无效（容器无 git / 无法用终端时）**
- **方案 A（推荐）**：在创空间 **配置 / 关联数据集** 里把数据集 <code>Data_for_GAS</code> 关联上，创空间可能会把数据集挂载到某个路径；在官方文档或运行日志中确认该路径后，在环境变量中设置 <code>DATA_DIR=挂载路径</code> 或 <code>DATASET_MOUNT_PATH=挂载路径</code>，重启应用即可把数据库写到持久化目录。
- **方案 B**：定期把数据库下载到本机备份。在浏览器打开：<code>https://你的创空间地址/admin/backup/download-db?password=管理员密码</code>（密码与管理后台一致），会下载 <code>study_experience.db</code>。重启创空间后数据会清空，但至少手头有备份可留存或日后恢复。

#### Clone with HTTP
```bash
 git clone https://www.modelscope.cn/studios/taoyao0498/Guidance_on_Application_and_streaming.git
```
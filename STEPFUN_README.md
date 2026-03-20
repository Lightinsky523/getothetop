# Stepfun（阶跃星辰）智能查询说明

## 用途

- 用 **Stepfun** 完成「智能查询」：考生填报志愿问答。
- **联网搜索**：可开关；可勾选「锚定 gov.cn 和 edu.cn」仅采用政府、教育官网数据。
- **知识库**：在 ECS 环境变量中配置 `STEPFUN_VECTOR_STORE_ID`（阶跃平台创建知识库并上传 ECS 上的资料后填入 ID），即可在对话中自动检索。

## 环境变量（在 ECS 上配置）

请在 ECS 服务器上设置环境变量（勿将 API Key 写入代码）：

| 变量 | 必填 | 说明 |
|------|------|------|
| `STEPFUN_API_KEY` | 是 | 阶跃星辰 API Key |
| `STEPFUN_MODEL` | 否 | 模型名，默认 `step-3.5-flash`（推理旗舰，性价比最高，支持联网搜索） |
| `STEPFUN_VECTOR_STORE_ID` | 否 | 【连接 ECS 资料】阶跃知识库 ID，用于 RAG |

## 接口

- **POST `/ai-query-step`**  
  与 `/ai-query` 入参一致：`prompt`, `profileSummary`, `isXuanke`, `xuankeContext`。  
  前端把请求从 `/ai-query` 改为 `/ai-query-step` 即可走 Stepfun。

## 修改 prompt

在 **`stepfun-ai.js`** 中：

- **系统提示**：改 `getSystemPrompt()` 的返回值。
- **联网搜索描述**：改 `getWebSearchTool()` 里 `function.description`，可进一步限定「仅从指定政府网站搜索」等说明（具体是否支持域名过滤需看阶跃 API 文档）。

## app.js 中「待删除-百炼」标注说明

- 已用注释标出两处：
  1. **`summarizeSharesWithBailian`**：学生分享总结用的百炼调用，可删除或改为调用 `stepfunSummarize`。
  2. **`/ai-query` 中的百炼 completion 调用**：从 `const appUrl = ...` 到解析 `aiText` 并 `res.send` 的整段，可删除并改为调用 `stepfun-ai` 的 `handleStepfunAiQuery` 或直接让前端请求 `/ai-query-step`。

若完全切换到 Stepfun，可：

- 保留 `/ai-query` 路由但把内部实现改为调用 `handleStepfunAiQuery(req, res, helpers)`；或
- 前端只请求 `/ai-query-step`，并视情况删除或注释上述百炼相关代码。

## 前端切换为 Stepfun

在 **index.html**（志愿填报页）中，将请求地址由 `/ai-query` 改为 `/ai-query-step` 即可，例如：

```javascript
const res = await fetch(API_BASE + '/ai-query-step', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ prompt: content, profileSummary: profile, isXuanke: queryMode === 'xuanke', xuankeContext }),
  signal: ctrl.signal
});
```

Vercel 的 `vercel.json` 已增加 `/ai-query-step` 到 ECS 的代理。

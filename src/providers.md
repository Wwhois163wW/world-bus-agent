# providers.ts 伴生澄清文档

## 1. 技术设计要点 / 总结

- **目标**: 实现“选定提供商自动填充模板 + 仅需填写 API Key + 一键测试连通性”的模型接入层。
- **内置提供商预设 (`PROVIDER_PRESETS`)**:
  - `vertex-express`: Google Vertex AI Express Mode（支持 `AQ.xxx` 密钥, 走 `@ai-sdk/google-vertex`）。
  - `gemini`: Google AI Studio OpenAI 兼容接口（`AIza...` 密钥）。
  - `openai`, `deepseek`, `openrouter`, `ollama`, `openai-compatible`: 统一由 `@ai-sdk/openai-compatible` 驱动, 自动补全默认 `baseURL` 与推荐 `model`。
- **自动识别逻辑 (`inferProviderId`)**: 当未显式填写 `provider` 时, 若 `apiKey` 以 `AQ.` 开头自动匹配 `vertex-express`, 若以 `AIza` 开头自动匹配 `gemini`, 其余默认走 `openai-compatible`。
- **连通性探针 (`testLlmConnection`)**: 发送最小文本生成请求（`maxOutputTokens: 16`）, 返回延迟 `latencyMs`, 模型响应或错误明细。

---

## 2. 变更记录流水

### [2026-11-18] @Antigravity, 20261118, [FEAT]: 创建模型提供商预设解析与连通性测试模块
- **修改原因**: 原 `src/maid.ts` 仅硬编码 `createOpenAICompatible`, 无法直接适配 Vertex AI Express `AQ.` 密钥, 且缺少提供商模板自动填充与连通性测试能力。
- **修改内容**: 新增 `src/providers.ts`, 提供 `PROVIDER_PRESETS`, `resolveLlmConfig`, `createLanguageModel`, `testLlmConnection`。

### [2026-11-18] @Antigravity, 20261118, [REFACTOR]: 改用官方 @google/genai Interactions API 驱动 Gemini
- **修改原因**: 卸载 `@ai-sdk/google-vertex`, 统一采用 `@google/genai` 标准 SDK (`ai.interactions.create`) 对接 `AQ.` / `AIza` 密钥及 `gemini-4-hydrogen`。
- **修改内容**: 新增 `runLlmTurn` 统一封装 `google-genai`（含 `FunctionCallStep` -> `FunctionResultStep` 多步工具循环）与 `openai-compatible`（`ToolLoopAgent`）, 并更新 `testLlmConnection` 与 `PROVIDER_PRESETS.gemini`。

### [2026-11-18] @Antigravity, 20261118, [FEAT]: 返回真实 Token usage 统计并放宽探针输出额度
- **修改原因**: 支撑 `maid.ts` 在 `END_TURN` 账本中记录精确 `tokenUsage`, 同时解决 `gemini-4-hydrogen` 等推理模型在探针 `max_output_tokens=16` 下可能耗尽额度导致 `reply` 为空的问题。
- **修改内容**:
  - 新增导出 `LlmRuntimeConfig` 与 `LlmUsage`, `runLlmTurn` 累计并返回 `usage` (`inputTokens`, `outputTokens`, `totalTokens`) 与 `text`。
  - `testLlmConnection` 中 `google-genai` 探针 `max_output_tokens` 调整为 `128`。

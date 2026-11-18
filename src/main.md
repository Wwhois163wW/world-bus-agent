# main.ts 伴生澄清文档

## 1. 技术设计要点 / 总结

- **核心生命周期引擎**: 实现 `createAgentRuntime(config, overrides?)` 与 `bootstrap()` 启动入口：
  - 启动时读取 `workspace/events.jsonl` 恢复 `eventsWindow`, 并基于 `END_TURN.payload.processedEventIds` 精确还原未结算的外部事件至 `Stock`。
  - 事件注入 `bus.ingest` 后先 Zod 校验并追加账本, 依次运行扩展参与者（业务异常转为 `EXTENSION_TASK_ERROR` 事件）, 最后按 `target` 与 `wake` / `busy` 状态分流至女仆或 `Stock`。
  - 底层异常（`BOOT`, `LEDGER_IO`, `MAID_TURN`, `UNCAUGHT`）执行 Fast-Fail, 旁路落盘 `CRASH_LATEST.json` 而不污染主账本。
- **HTTP 控制面**: 提供 `GET /status`, `POST /events`, `POST /tick`, `GET /llm/providers`, `POST /llm/test`。

---

## 2. 变更记录流水

### [2026-11-18] @Antigravity, 20261118, [FEAT]: 接入泛用提供商配置与 HTTP 连通性测试接口
- **修改原因**: 支持设置 `provider` 自动填充模板及测试连通性, 并支持 Google Vertex Express `AQ.` 密钥。
- **修改内容**:
  - 将 `RuntimeConfig.llm` 更新为 `LlmConfig`。
  - 新增 `GET /llm/providers` 与 `POST /llm/test` 控制面接口。
  - 在 `bootstrap()` 中读取 `LLM_PROVIDER`, 并移除写死的 `deepseek` 默认 `baseURL` / `model` 以便由预设模板自动填充。

### [2026-11-18] @Antigravity, 20261118, [FEAT]: RuntimeConfig 支持透传可选 budget 上下文预算配置
- **修改原因**: 允许运行时通过配置文件自定义 `ContextBudgetConfig`, 由 `maid.ts` 负责消费治理。
- **修改内容**: 在 `RuntimeConfig` 新增 `budget?: ContextBudgetConfig`, 并在 `createAgentRuntime` 初始化 `createMaidParticipant` 时透传 `budget: config.budget`。

### [2026-11-18] @Antigravity, 20261118, [FIX]: 修复扩展相对路径解析并支持 enabled 开关
- **修改原因**: 原 `jiti.import(ext.module)` 基于 `import.meta.url` (`src/main.ts` 或 `dist/main.js`) 解析 `./extensions/...`, 导致无法命中项目根目录下的扩展文件, 且缺少 `enabled: false` 跳过逻辑。
- **修改内容**: 相对路径通过 `resolve(process.cwd(), ext.module)` 解析后再加载, 并在 `ext.enabled === false` 时跳过加载。

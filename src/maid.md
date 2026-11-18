# maid.ts 伴生澄清文档

## 1. 技术设计要点 / 总结

- **纯总线收发分离**: `createMaidParticipant` 实现 `BusParticipant<MaidConsumedPrompt, MaidTurnResult>` 契约：
  - `consume`: 纯函数, 负责将 `DIARY.md`, `eventsWindow`, `triggerReason` 与待处理事件批次拼装为提示词, 并根据 `responseMode === "tool_required"` 计算 `requiresTool`。
  - `produce`: 纯函数, 将本轮最终文本, `consumedEventIds` 与 `toolTrace` 封装为 `END_TURN` 结算事件（`wake: false`, `outbound: false`）。
  - `execute`: 异步执行层, 通过 `@ai-sdk/openai-compatible` 创建泛用 OpenAI 兼容模型客户端并驱动 `ToolLoopAgent` 进行工具循环。

---

## 2. 变更记录流水

### [2026-11-18] @Antigravity, 20261118, [FIX]: 对齐 ai@6 TypedToolCall 字段名
- **修改原因**: 在 `ai@^6.0.0` 中, `TypedToolCall` / `DynamicToolCall` 的工具调用入参属性已由 `args` 更名为 `input`, 导致 `tsc` 报错 `Property 'args' does not exist`。
- **修改内容**: 按非破坏性编辑原则保留原 `tc.args` 代码行注释, 在下方改为读取 `tc.input` 映射至 `MaidTurnResult.toolTrace[i].args`, 保持对外结构兼容 `tests/maid.test.ts`。

### [2026-11-18] @Antigravity, 20261118, [REFACTOR]: 接入泛用提供商模板模块
- **修改原因**: 原实现仅直接调用 `createOpenAICompatible`, 无法适配 Vertex AI Express 等非 OpenAI 协议提供商, 且不支持提供商预设模板自动补全。
- **修改内容**: 改用 `src/providers.ts` 的 `createLanguageModel` 与 `LlmConfig` 类型创建模型实例, 原代码行均注释保留。

### [2026-11-18] @Antigravity, 20261118, [REFACTOR]: 委派 runLlmTurn 统一执行工具循环
- **修改原因**: 需同时支持 `@google/genai` 原生 `Interactions API` 工具循环与 `OpenAI-Compatible` 的 `ToolLoopAgent`。
- **修改内容**: `execute` 改为直接调用 `runLlmTurn`, 原代码行均注释保留。

### [2026-11-18] @Antigravity, 20261118, [FEAT]: 内置上下文窗口治理与 Token 预算管理
- **修改原因**: 补全 `ARCHITECTURE.md` 第 4.3 节提出的上下文窗口治理留白, 避免超长输出撑爆模型上下文或历史事件无限膨胀。
- **修改内容**:
  - 新增纯函数 `estimateTokens`, `truncateMiddle`（掐头留尾 45%+45% 截断）与 `sanitizeEventForPrompt`（已结算历史字段限额减半）。
  - `consume` 实行刚性区（`pendingBatch` + `DIARY.md`）与弹性区（`eventsWindow` 倒序装箱）分离, 并在超水位线或发生历史丢弃时自动注入 `DIARY.md` 归档指令。
  - `execute` 与 `produce` 收集并写回 `tokenUsage`（含估算与真实 API Token 账单）至 `END_TURN.payload.tokenUsage`。

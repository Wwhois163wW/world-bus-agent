# extensions/example-echo/index.ts 伴生澄清文档

## 1. 技术设计要点 / 总结

- **契约对齐**: 实现 `src/types.ts` 定义的 `AgentExtension` 默认导出函数 `(bus: WorldBusContext, options?) => void`。
- **能力示例**:
  1. 通过 `bus.registerTool("echo_ping", ...)` 向 LLM 注入受 Zod 约束的扩展工具（使用 `ai@6` `inputSchema`）。
  2. 通过 `bus.registerParticipant(...)` 注册 ID 为 `"ext.example.echo"` 的总线参与者：
     - `consume`: 匹配 `type === "PING_TEST"` 事件。
     - `execute`: 支持通过 `payload.simulateError === true` 模拟任务报错以验证 Layer 1 错误降级。
     - `produce`: 打包生成 `PONG_RESULT` 事件写回总线（`wake: false`, `outbound: false`）。

---

## 2. 变更记录流水

### [2026-11-18] @Antigravity, 20261118, [REFACTOR]: 按新版 AgentExtension + BusParticipant 契约重写
- **修改原因**: 原代码仍使用已废弃的 `ExtensionFactory` / `LocalWorldEvent` 接口, 无法被 `src/main.ts` 正常加载。
- **修改内容**: 按非破坏性编辑原则将旧实现完整注释保留, 重写为标准 `AgentExtension` 并新增 `echo_ping` 工具与 `PING_TEST`/`PONG_RESULT` 参与者逻辑。

### [2026-11-18] @Antigravity, 20261118, [FEAT]: 补充 ParticipantManifest 自描述契约与 prefix/target 匹配
- **修改原因**: 示范扩展如何通过 `manifest` 向女仆暴露自身职责与 `consumes`/`produces` 事件契约。
- **修改内容**: 增加 `manifest` 字段, 支持 `options.prefix` 前缀格式化与 `target` 精确过滤。

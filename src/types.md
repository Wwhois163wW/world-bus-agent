# types.ts 伴生澄清文档

## 1. 技术设计要点 / 总结

- **事件信封契约**: `BusEventSchema` 定义全部进入 `events.jsonl` 的合法事件字段。
- **纯总线收发契约 (`BusParticipant`)**: 所有总线参与者（含女仆与外部扩展）通过 `consume`（纯函数）, `execute`（异步算子）, `produce`（纯函数）接入总线。
- **扩展自描述契约 (`ParticipantManifest`)**: 供扩展声明 `description`, `consumes` 与 `produces`, 由运行时透传至 `maid.consume` 自动构建 LLM 可读的扩展感知目录。

---

## 2. 变更记录流水

### [2026-11-18] @Antigravity, 20261118, [FEAT]: 新增 ParticipantManifest 扩展自描述契约
- **修改原因**: 解决女仆无法感知已挂载扩展的 `target`/`type`/`payload` 交互契约与来信 `source` 含义的问题。
- **修改内容**: 新增 `ParticipantManifest` 接口, 为 `BusParticipant` 添加可选 `manifest`, 并为 `consume` 的 `extraContext` 增加 `extensions` 字段。

# maid.test.ts 伴生澄清文档

## 1. 技术设计要点 / 总结

- **测试覆盖范围**:
  1. `consume`: 空批次返回 `null`；非空时正确注入 `DIARY.md` 与 `【强制调用工具】` 约束。
  2. `produce`: 打包 `END_TURN` 结算事件与 `processedEventIds` / `toolTrace`。
  3. 上下文治理 1: 单条超长文本/载荷触发 `truncateMiddle` 掐头留尾截断（保留 `HEAD_MARKER_` 与 `_TAIL_MARKER`）。
  4. 上下文治理 2: 历史窗口超过 `maxContextTokens` 预算时倒序装箱（保留最新 `EVT-HIST-10`, 淘汰早期 `EVT-HIST-1`）, 并触发 `【上下文水位告警】`。

---

## 2. 变更记录流水

### [2026-11-18] @Antigravity, 20261118, [TEST]: 新增上下文窗口治理两项单元测试
- **修改原因**: 验证 `src/maid.ts` 新增的掐头留尾截断, 逆序 Token 装箱及归档水位告警逻辑。
- **修改内容**: 在 `tests/maid.test.ts` 中新增 `上下文治理 1` 与 `上下文治理 2` 测试用例。

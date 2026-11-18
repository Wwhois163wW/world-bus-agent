# providers.test.ts 伴生澄清文档

## 1. 技术设计要点 / 总结

- **测试覆盖范围**: 验证 `resolveLlmConfig` 在“指定预设名自动补全”, “按 `AQ.` / `AIza` 密钥前缀自动识别”, “用户显式覆盖 `baseURL` 与 `model`”三种场景下的纯函数行为（离线执行, 不依赖外网）。

---

## 2. 变更记录流水

### [2026-11-18] @Antigravity, 20261118, [TEST]: 新增 providers.test.ts
- **修改原因**: 验证 `src/providers.ts` 提供商模板逻辑正确性。
- **修改内容**: 新增 3 个离线单元测试用例。

### [2026-11-18] @Antigravity, 20261118, [REFACTOR]: 对齐 @google/genai 预设断言
- **修改原因**: `vertex-express` 已移除并统一至 `gemini` (`google-genai`, 默认模型 `gemini-4-hydrogen`)。
- **修改内容**: 按非破坏性编辑原则保留原断言注释, 更新为 `gemini` / `google-genai` 断言。

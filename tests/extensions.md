# extensions.test.ts 伴生澄清文档

## 1. 技术设计要点 / 总结

- **测试覆盖范围**:
  1. `jiti` 动态加载相对路径 `./extensions/example-echo/index.ts`, 验证扩展注册的 `echo_ping` 工具与 `PING_TEST` -> `PONG_RESULT` 自动回响。
  2. 验证扩展运行期抛错自动降级为 `EXTENSION_TASK_ERROR` 并唤醒女仆, 不产生崩溃报告。
  3. 验证 `extensions[].enabled === false` 跳过加载, 以及不存在的扩展模块触发 `BOOT` 阶段 Fast-Fail 落盘 `CRASH_LATEST.json`。

---

## 2. 变更记录流水

### [2026-11-18] @Antigravity, 20261118, [TEST]: 新增扩展加载与 example-echo 集成测试
- **修改原因**: 配合 `extensions/example-echo/index.ts` 重写与 `src/main.ts` 相对路径解析修复, 端到端验证扩展生命周期。
- **修改内容**: 新增 3 个集成测试用例。

# error-and-http.test.ts 伴生澄清文档

## 1. 技术设计要点 / 总结

- **测试覆盖范围**:
  1. Layer 1 任务报错降级: 扩展 `execute` 抛错转为 `EXTENSION_TASK_ERROR` 唤醒女仆, 不生成 `CRASH_LATEST.json`。
  2. Layer 2 底层崩溃: `MAID_TURN` 异常旁路落盘 `CRASH_LATEST.json`, 触发 `onCrash` 与退出码 `1`, 保持 `events.jsonl` 干净。
  3. 启动账本损坏 `BOOT` Fast-Fail 验证。
  4. HTTP 控制面 `/events` (201 & 400), `/status` (200), `/tick` (200) 端到端验证。
  5. HTTP `GET /llm/providers` 预设列表验证（确认无密钥泄露）。
  6. HTTP `POST /llm/test` 本地 Mock Server 端到端验证（缺密钥 400, 上游 401 降级 400, 正常连通返回 200 与 `"OK"`）。

---

## 2. 变更记录流水

### [2026-11-19] @Antigravity, 20261119, [TEST]: 补全 /tick, /llm/providers 与 /llm/test Mock 单元测试
- **修改原因**: 实现 HTTP 控制面全部 5 个端点的 100% 离线自动化测试覆盖。
- **修改内容**: 在用例 4 补充 `POST /tick` 断言, 新增用例 5 (`GET /llm/providers`) 与用例 6 (`POST /llm/test` 本地 `node:http` Mock 服务测试), 并补建本伴生文档。

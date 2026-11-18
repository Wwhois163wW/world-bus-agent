# World Bus Agent 开发进度文档

> **更新时间**: 2026-11-18
> **当前阶段**: 最小可运行核心已跑通（编译, 构建, 离线单测及 DeepSeek / Gemini 双通道真实 E2E 闭环均已验证）

---

## 1. 阶段里程碑总览

| 阶段 | 状态 | 关键成果 |
| :--- | :--- | :--- |
| **Phase 0: 仓库清点与契约对齐** | ✅ 已完成 | 梳理 `tests/` 设计意图, 产出 [API_REQUIREMENTS.md](./API_REQUIREMENTS.md) |
| **Phase 1: 根目录配置与旧代码清理** | ✅ 已完成 | 对齐 `agent.config.example.json`, 清理 5 个旧架构残留文件 (`cli.ts`, `ControlServer.ts`, `loader.ts`, `validator.ts`, `WorldBusCore.ts`), 修复 `ai@6` 类型不匹配 |
| **Phase 2: 泛用模型接入与真实闭环实测** | ✅ 已完成 | 实现 `src/providers.ts`, 集成 `@ai-sdk/openai-compatible@^2.0.94` 与 `@google/genai@^3.5.0`, 完成 DeepSeek 与 Gemini (`AQ.`) 真实工具闭环测试 |
| **Phase 3: 工作区规则与文档体系** | ✅ 已完成 | 建立根目录优先规则 [GEMINI.md](../GEMINI.md), 补充架构设计文档与开发进度文档 |
| **Phase 4: 扩展适配与工程化优化** | ⏳ 待启动 | 适配 `extensions/example-echo`, 完善 CLI 启动体验与参考开源项目优化 |

---

## 2. 模块完成度矩阵

| 模块 / 文件 | 状态 | 已实现与验证能力 | 备注 / 待改进项 |
| :--- | :--- | :--- | :--- |
| `src/types.ts` | ✅ 稳定 | `BusEventSchema` Zod 校验与 `BusParticipant` / `WorldBusContext` 契约 | 可按需扩展消息元数据字段 |
| `src/main.ts` | ✅ 已验证 | 事件入账, `Stock` 分流与 `Tick` 排空, `Busy` 锁续接, 断电恢复, HTTP 控制面 (`/status`, `/events`, `/tick`, `/llm/providers`, `/llm/test`), 双层报错隔离 | 缺少优雅停机 (`SIGINT`/`SIGTERM`) 与服务器实例关闭句柄导出 |
| `src/maid.ts` | ✅ 已验证 | 纯函数 `consume` (`DIARY.md` + `eventsWindow` + `tool_required`) 与 `produce` (`END_TURN`), 委派 `runLlmTurn` | 待补充多轮记忆裁剪策略 |
| `src/providers.ts` | ✅ 已验证 | 提供商预设模板自动补全, `AQ.`/`AIza` 自动识别, `@google/genai` `Interactions API` 多步工具循环, `OpenAI-Compatible` `ToolLoopAgent`, `testLlmConnection` | `testLlmConnection` 的 `max_output_tokens: 16` 对推理模型偏小, 建议放宽至 `64`~`128` |
| `src/tools.ts` | ✅ 已验证 | `read_file`, `write_file`, `list_dir` 沙箱与越界拦截, `exec_cli` 零静默返回, `emit_event` 防自激铁律 | 待评估是否补充文件编辑 (`edit_file`) 或文件大小限制 |
| `src/crash.ts` | ✅ 已验证 | 旁路同步写入 `crashes/CRASH-*.json` 与 `CRASH_LATEST.json` | 满足当前需求 |
| `extensions/example-echo/index.ts` | ⚠️ 待修复 | 仍为上一代 `ExtensionFactory` / `LocalWorldEvent` 写法 | 需重写为新版 `AgentExtension` 以配合 `jiti` 加载测试 |
| `tests/*.test.ts` | ✅ 5 文件 16 用例全过 | 覆盖 `maid`, `lifecycle`, `error-and-http`, `tools`, `providers` | 待补充 `POST /llm/test`, `GET /llm/providers` 与扩展加载失败 (`BOOT`) 的 HTTP/集成单测 |

---

## 3. 已验证记录摘要

### 3.1 编译与离线单元测试（最近一次执行通过）
- `npm run typecheck` (`tsc --noEmit`): 退出码 0。
- `npm run build` (`tsc`): 退出码 0。
- `npm test` (`vitest run`): 5 个测试文件, 16 个测试用例全部通过：
  - `tests/providers.test.ts` (3 tests)
  - `tests/maid.test.ts` (2 tests)
  - `tests/lifecycle.test.ts` (3 tests)
  - `tests/error-and-http.test.ts` (4 tests)
  - `tests/tools.test.ts` (4 tests)

### 3.2 在线真实闭环实测记录（临时工作区与内存密钥, 测试后已释放）
1. **DeepSeek (`provider: "deepseek"`, `deepseek-chat`)**:
   - 连通性探针通过（`947ms`, 返回 `"OK"`）。
   - `POST /events` (`USER_AIM`, `responseMode: "tool_required"`) 完整触发 4 步工具调用（`write_file` `DIARY.md` -> `read_file` -> `emit_event` `TASK_DONE` -> `write_file` `REPORT.md`）, 结算 `END_TURN` 且 `stockCount` 归 `0`。
2. **Gemini (`@google/genai`, `AQ.` 密钥自动识别为 `gemini-4-hydrogen`)**:
   - 连通性探针通过（`ok: true`, `5836ms`, 见待改进项关于 `max_output_tokens` 的说明）。
   - `POST /events` (`USER_AIM`, `responseMode: "tool_required"`) 通过 `Interactions API` 正确触发 `write_file` 创建 `DIARY.md` 并写入 `"当前活跃课题: pe_aging_2026"`, 结算 `END_TURN` 且 `stockCount` 归 `0`。

---

## 4. 下一步待办清单（Roadmap）

### P0 — 最小核心收尾与缺口补齐
1. **修复探针输出额度**: 调整 `src/providers.ts` 中 `testLlmConnection` 的 `max_output_tokens`（如 `128`）, 确保 `gemini-4-hydrogen` 等推理模型正常返回 `"OK"` 文本。
2. **重写示例扩展**: 将 `extensions/example-echo/index.ts` 适配为新版 `AgentExtension` 契约, 并补充 `extensions` 动态挂载与 `EXTENSION_TASK_ERROR` 端到端测试。
3. **补全 HTTP 测试用例**: 为 `GET /llm/providers` 与 `POST /llm/test` 增加 Mock 测试用例；同步更新 [API_REQUIREMENTS.md](./API_REQUIREMENTS.md) 收录这两个接口。

### P1 — 实验运行可用性增强
1. **优雅停机与资源释放**: 为 `createAgentRuntime` 返回值增加 `close()` / `shutdown()` 方法以清理 `serve()` 与 `setInterval` 定时器, 配合 `SIGINT`/`SIGTERM` 信号处理。
2. **上下文窗口与日志观测**: 优化长对话下 `eventsWindow` 的可读摘要格式, 避免历史 `toolTrace` 膨胀导致单轮 Prompt Token 过高。
3. **本地真实服务启动验证**: 通过 `agent.config.json` 与 `npm run dev` 验证守护进程模式运行稳定性。

### P2 — 参考开源项目优化与多节点扩展
1. **跨节点桥接扩展**: 基于 `outbound` 事件标志开发独立的节点间通信扩展（如 HTTP Webhook / Redis Stream 桥接）。
2. **提供商目录与交互优化**: 参考成熟开源项目（如 Vercel AI / LiteLLM / 开源 Agent 框架）的提供商能力声明与错误重试策略, 优化多提供商切换与限流退避处理。

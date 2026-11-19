# World Bus Agent 开发进度文档

> **更新时间**: 2026-11-19
> **当前阶段**: 🎉 **核心版本已封版**（编译, 构建, 全量 6 文件 25 用例离线测试 100% 覆盖, 及 DeepSeek / Gemini 双通道真实 E2E 闭环均已验证）

---

## 1. 阶段里程碑总览

| 阶段 | 状态 | 关键成果 |
| :--- | :--- | :--- |
| **Phase 0: 仓库清点与契约对齐** | ✅ 已完成 | 梳理 `tests/` 设计意图, 产出 [API_REQUIREMENTS.md](./API_REQUIREMENTS.md) |
| **Phase 1: 根目录配置与旧代码清理** | ✅ 已完成 | 对齐 `agent.config.example.json`, 清理 5 个旧架构残留文件 (`cli.ts`, `ControlServer.ts`, `loader.ts`, `validator.ts`, `WorldBusCore.ts`), 修复 `ai@6` 类型不匹配 |
| **Phase 2: 泛用模型接入与真实闭环实测** | ✅ 已完成 | 实现 `src/providers.ts`, 集成 `@ai-sdk/openai-compatible@^2.0.94` 与 `@google/genai@^3.5.0`, 完成 DeepSeek 与 Gemini (`AQ.`) 真实工具闭环测试 |
| **Phase 3: 工作区规则与文档体系** | ✅ 已完成 | 建立根目录优先规则 [GEMINI.md](../GEMINI.md), 补充架构设计文档与开发进度文档 |
| **Phase 4: 上下文治理, 扩展感知与工程封版** | ✅ 已完成 | 完成 `Maid` 上下文治理、`ParticipantManifest` 扩展感知、`example-echo` 示范、`runtime.shutdown()` 优雅停机、HTTP 100% Mock 单测覆盖与 `.gitignore` 加固 |

---

## 2. 模块完成度矩阵

| 模块 / 文件 | 状态 | 已实现与验证能力 | 备注 / 待改进项 |
| :--- | :--- | :--- | :--- |
| `src/types.ts` | ✅ 稳定 | `BusEventSchema` Zod 校验, `BusParticipant` / `ParticipantManifest` / `WorldBusContext` 契约 | 可按需扩展消息元数据字段 |
| `src/main.ts` | ✅ 已验证 | 事件入账, `Stock` 分流与 `Tick` 排空, `Busy` 锁续接, 断电恢复, 相对路径扩展加载与 `enabled` 开关, `budget` 与扩展清单透传, `runtime.shutdown()` 优雅停机, HTTP 控制面 (`/status`, `/events`, `/tick`, `/llm/providers`, `/llm/test`), 双层报错隔离 | 后续可补充运行时热更新 `/config/llm` |
| `src/maid.ts` | ✅ 已验证 | 纯函数 `consume`（含扩展感知目录, 掐头留尾截断, 逆序 Token 装箱, 水位告警）与 `produce`（`END_TURN` + `tokenUsage` 账单）, 委派 `runLlmTurn` | 满足当前需求 |
| `src/providers.ts` | ✅ 已验证 | 提供商预设模板自动补全, `AQ.`/`AIza` 自动识别, `@google/genai` `Interactions API` 多步工具循环, `OpenAI-Compatible` `ToolLoopAgent`, `usage` 提取, `testLlmConnection` (`max_output_tokens: 128`) | 后续可补充网络限流重试退避 |
| `src/tools.ts` | ✅ 已验证 | `read_file`, `write_file`, `list_dir` 沙箱与越界拦截, `exec_cli` 零静默返回, `emit_event` 防自激铁律 | 待评估是否补充文件编辑 (`edit_file`) 或文件大小限制 |
| `src/crash.ts` | ✅ 已验证 | 旁路同步写入 `crashes/CRASH-*.json` 与 `CRASH_LATEST.json` | 满足当前需求 |
| `extensions/example-echo/index.ts` | ✅ 已验证 | 已重写为新版 `AgentExtension`, 附带 `manifest` 自描述契约, 注册 `echo_ping` 工具与 `PING_TEST`/`PONG_RESULT` 参与者 | 满足示例与集成测试需求 |
| `tests/*.test.ts` | ✅ 6 文件 25 用例全过 | 覆盖 `providers`, `maid` (含上下文治理), `lifecycle`, `error-and-http` (HTTP 5 端点 100% 覆盖), `tools`, `extensions` (含 `Manifest` 感知与 `shutdown`) | 全量核心契约与 HTTP 端点覆盖完成 |

---

## 3. 已验证记录摘要

### 3.1 编译与离线单元测试（最近一次执行通过）
- `npm run typecheck` (`tsc --noEmit`): 退出码 0。
- `npm run build` (`tsc`): 退出码 0。
- `npm test` (`vitest run`): 6 个测试文件, 25 个测试用例全部通过：
  - `tests/providers.test.ts` (3 tests)
  - `tests/maid.test.ts` (4 tests, 含上下文治理 2 项用例)
  - `tests/lifecycle.test.ts` (3 tests)
  - `tests/error-and-http.test.ts` (6 tests, 含 `/events`, `/status`, `/tick`, `/llm/providers`, `/llm/test` HTTP Mock 覆盖)
  - `tests/tools.test.ts` (4 tests)
  - `tests/extensions.test.ts` (5 tests, 含扩展 `Manifest` 感知与优雅停机保护)

### 3.2 在线真实闭环实测记录（临时工作区与内存密钥, 测试后已释放）
1. **DeepSeek (`provider: "deepseek"`, `deepseek-chat`)**:
   - 连通性探针通过（`947ms`, 返回 `"OK"`）。
   - `POST /events` (`USER_AIM`, `responseMode: "tool_required"`) 完整触发 4 步工具调用（`write_file` `DIARY.md` -> `read_file` -> `emit_event` `TASK_DONE` -> `write_file` `REPORT.md`）, 结算 `END_TURN` 且 `stockCount` 归 `0`。
2. **Gemini (`@google/genai`, `AQ.` 密钥自动识别为 `gemini-4-hydrogen`)**:
   - 连通性探针通过（`ok: true`, `5836ms`, 见待改进项关于 `max_output_tokens` 的说明）。
   - `POST /events` (`USER_AIM`, `responseMode: "tool_required"`) 通过 `Interactions API` 正确触发 `write_file` 创建 `DIARY.md` 并写入 `"当前活跃课题: pe_aging_2026"`, 结算 `END_TURN` 且 `stockCount` 归 `0`。

---

## 4. 后续可选演进方向（Future Roadmap）

### 后续演进建议（非封版阻塞项）
1. **探针在线回归与守护进程实测**: 针对放宽 `max_output_tokens: 128` 后的推理模型探针及 `npm run dev` 守护模式做日常观测。
2. **运行时配置热更新**: 评估是否补充 `POST /config/llm` 动态切换模型配置。
3. **跨节点桥接扩展**: 基于 `outbound` 事件标志开发独立的节点间通信扩展（如 HTTP Webhook / Redis Stream 桥接）。
4. **提供商能力增强**: 参考成熟开源项目补充网络限流重试退避策略。

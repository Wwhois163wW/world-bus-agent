# package.json 伴生澄清文档

## 1. 技术设计要点 / 总结

- **模块规范**: 纯 ESM (`"type": "module"`), Node.js v22+ 环境运行。
- **泛用模型依赖**: 采用 Vercel AI SDK (`ai`) 配合 `@ai-sdk/openai-compatible` 作为泛用大模型接入底座, 支持所有兼容 OpenAI 协议的 API 来源, 避免引入单一厂商（如 `openai` 官方 SDK 或特定厂商专有 SDK）的强绑定依赖。
- **核心基础设施**:
  - `hono` + `@hono/node-server`: 本地 HTTP 控制面（`/events`, `/status`, `/tick`）。
  - `c12`: 分层配置加载（读取 `agent.config.*` 与默认值）。
  - `jiti`: 动态运行时加载 TypeScript/JavaScript 扩展模块。
  - `zod`: 事件与工具参数的运行时 Schema 校验。
- **脚本**: 增加 `typecheck` (`tsc --noEmit`), 便于在不生成产物的前提下快速校验 TypeScript 类型完整性。

---

## 2. 变更记录流水

### [2026-11-18] @Antigravity, 20261118, [FEAT]: 补充 typecheck 脚本并确认泛用依赖清单
- **修改原因**: 方便后续逐个修复 `src/` 文件时进行无产物类型检查, 同时确认保留泛用模型接入依赖而不安装旧版残留的 `openai` / `ajv`。
- **修改内容**: 在 `scripts` 中增加 `"typecheck": "tsc --noEmit"`。

### [2026-11-18] @Antigravity, 20261118, [FEAT]: 安装 @ai-sdk/google-vertex@^4.0.234
- **修改原因**: 支持 Google Vertex AI Express Mode（`AQ.` API Key）, 同时匹配 `ai@6.0.333` 所依赖的 `@ai-sdk/provider@3.0.19` 协议版本。
- **修改内容**: 通过 `npm install @ai-sdk/google-vertex@^4.0.234` 添加依赖。

### [2026-11-18] @Antigravity, 20261118, [UPGRADE]: 升级 @ai-sdk/openai-compatible 至 ^2.0.94
- **修改原因**: 消除 `ai@6` 下的 `v2 specification compatibility mode` 警告, 对齐 `ProviderV3` 规范。
- **修改内容**: 通过 `npm install @ai-sdk/openai-compatible@^2.0.94` 升级依赖。

### [2026-11-18] @Antigravity, 20261118, [REFACTOR]: 安装 @google/genai 并卸载 @ai-sdk/google-vertex
- **修改原因**: 按最新 Gemini API 规范, 统一由官方 `@google/genai` SDK 的 `interactions.create` 对接 `AQ.` 密钥。
- **修改内容**: 执行 `npm install @google/genai` 与 `npm uninstall @ai-sdk/google-vertex`。
- **原文件完整备份（因 JSON 不支持注释, 按非破坏性归档策略留存）**:
```json
{
  "name": "world-bus-agent",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "dev": "tsx src/main.ts",
    "build": "tsc",
    "start": "node dist/main.js",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@ai-sdk/openai-compatible": "^1.0.0",
    "@hono/node-server": "^1.14.0",
    "ai": "^6.0.0",
    "c12": "^3.0.0",
    "hono": "^4.7.0",
    "jiti": "^2.4.2",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "tsx": "^4.19.2",
    "typescript": "^5.7.0",
    "vitest": "^2.1.8"
  }
}
```

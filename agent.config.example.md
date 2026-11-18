# agent.config.example.json 伴生澄清文档

## 1. 技术设计要点 / 总结

- **目标对齐**: 本配置模板严格对齐核心运行时 `src/main.ts` 中定义的 `RuntimeConfig` 接口, 移除了旧版残留的嵌套字段（`controlServer`, `brain`, `wakeOnTypes`, `temperature`）。
- **核心配置字段说明**:
  - `nodeId`: 当前总线节点标识（如 `leadership.center`）。
  - `workspaceDir`: 节点工作区目录（存放 `events.jsonl`, `DIARY.md`, `crashes/`）。
  - `port`: 本地 HTTP 控制面端口（默认 `3100`）。
  - `windowSize`: 内存中保留的最近事件滑动窗口容量。
  - `tickIntervalMs`: 定时脉冲排空 `Stock` 的间隔毫秒数（`0` 表示关闭自动定时脉冲）。
  - `llm`: 泛用 OpenAI-Compatible 模型接入配置。预留 `provider` 字段用于后续实现“按提供商预设自动填充 `baseURL` / `model` 模板并支持连通性测试”；当前阶段显式提供 `baseURL`, `apiKey`, `model`, `systemPrompt`, `maxSteps` 以兼容现有 `src/main.ts`。
  - `extensions`: 扩展模块列表, 示例默认为空数组 `[]`。

---

## 2. 变更记录流水

### [2026-11-18] @Antigravity, 20261118, [REFACTOR]: 对齐 RuntimeConfig 结构与泛用 LLM 示例
- **修改原因**: 原模板使用旧版 `controlServer` / `brain` 结构且写死 `deepseek` 与无效的 `example-echo` 扩展路径, 无法与 `src/main.ts` 的 `RuntimeConfig` 匹配。
- **修改内容**:
  - 平铺对齐 `port`, `tickIntervalMs`, `llm`, `extensions: []`。
  - 增加泛用 `provider: "openai-compatible"` 标识与通用默认 `baseURL` / `model` 示例。
- **原文件完整备份（因 JSON 不支持注释, 按非破坏性归档策略留存）**:
```json
{
  "nodeId": "leadership.center",
  "workspaceDir": "./workspace",
  "windowSize": 30,
  "controlServer": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 3100
  },
  "brain": {
    "enabled": false,
    "systemPrompt": "你是一个基于事件流控制反转（IoC）的实验室智能体。请根据最近事件窗口输出严格合法的结构化动作。",
    "wakeOnTypes": ["USER_AIM", "MANUAL_WAKE", "STAGE_DONE", "TOOL_EXECUTION_ERROR"],
    "llm": {
      "baseURL": "https://api.deepseek.com/v1",
      "apiKey": "sk-replace-with-your-key",
      "model": "deepseek-chat",
      "temperature": 0.1
    }
  },
  "extensions": [
    {
      "module": "./extensions/example-echo/index.ts",
      "enabled": true,
      "options": {
        "greeting": "Echo hand is armed and listening."
      }
    }
  ]
}
```

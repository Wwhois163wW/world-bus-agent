# world-bus-agent

<!-- @Antigravity, 20261118, [DOCS]: 补充项目概述, 配置指南与脚本说明 -->

基于事件流控制反转（IoC）的节点级智能体运行时。详细接口契约请参阅 [docs/API_REQUIREMENTS.md](docs/API_REQUIREMENTS.md)。

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置节点

方式 A：复制示例配置为 `agent.config.json`（优先由 `c12` 加载）：

```bash
cp agent.config.example.json agent.config.json
```

方式 B：通过环境变量覆盖（参考 `.env.example`）：

- `AGENT_NODE_ID`: 节点 ID（默认 `leadership.center`）
- `AGENT_PORT`: HTTP 控制面端口（默认 `3100`）
- `LLM_API_KEY`: API 密钥（设置后自动启用 LLM）
- `LLM_BASE_URL`: 兼容 OpenAI 协议的接口地址
- `LLM_MODEL`: 模型名称

### 3. 运行与测试

```bash
# 运行单元测试（Vitest）
npm test

# 启动开发模式
npm run dev

# 类型检查与构建
npm run typecheck
npm run build
```

> **注意**: 当前阶段正在清理旧版 `src/` 残留文件, `npm test` 已全部通过（4 文件 13 用例）, `npm run build` / `typecheck` 将在完成 `src/` 清理与修复后恢复通过。

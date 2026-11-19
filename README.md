# world-bus-agent

<!-- @Antigravity, 20261118, [DOCS]: 补充项目概述, 配置指南与脚本说明 -->
<!-- @Antigravity, 20261119, [DOCS]: 移除旧版清理中过期提示, 对齐封版架构, HTTP 端点与全量测试状态 -->

基于事件流控制反转（IoC）的节点级智能体运行时。内置账本持久化 (`events.jsonl`)、断电无损 `Stock` 恢复、双层错误隔离、Maid 上下文窗口治理、扩展自描述感知 (`ParticipantManifest`) 以及多协议泛用模型接入（`@google/genai` 与 `@ai-sdk/openai-compatible`）。

## 文档导航

- [接口需求说明 (docs/API_REQUIREMENTS.md)](docs/API_REQUIREMENTS.md)
- [系统架构设计 (docs/ARCHITECTURE.md)](docs/ARCHITECTURE.md)
- [开发进度与封版记录 (docs/PROGRESS.md)](docs/PROGRESS.md)

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置节点

方式 A：复制示例配置为 `agent.config.json`（优先由 `c12` 加载, 已列入 `.gitignore`）：

```bash
cp agent.config.example.json agent.config.json
```

方式 B：通过环境变量覆盖（参考 `.env.example`）：

- `AGENT_NODE_ID`: 节点 ID（默认 `leadership.center`）
- `AGENT_PORT`: HTTP 控制面端口（默认 `3100`）
- `LLM_PROVIDER`: 模型提供商预设（如 `gemini`, `openai`, `deepseek`, `openrouter`, `ollama`, `openai-compatible`；缺省时按 `API Key` 前缀自动识别）
- `LLM_API_KEY`: API 密钥（设置后自动启用 LLM）
- `LLM_BASE_URL`: 兼容 OpenAI 协议的接口地址（选用预设时可省略）
- `LLM_MODEL`: 模型名称（选用预设时可省略）

### 3. HTTP 控制面端点

启动后默认监听 `http://127.0.0.1:3100`：

- `GET /status`: 查询节点 `busy`, `crashed`, `stock`, `recentWindow` 与已挂载 `tools`
- `POST /events`: 校验并向总线注入事件（非法载荷拦截返回 `400`, 不污染账本）
- `POST /tick`: 触发旁路脉冲, 排空积压在 `Stock` 中的静默事件
- `GET /llm/providers`: 查看内置提供商预设目录
- `POST /llm/test`: 执行 LLM 连通性探针测试

### 4. 运行、构建与测试

```bash
# 运行全量单元测试（Vitest）
npm test

# 类型检查与编译构建
npm run typecheck
npm run build

# 启动开发模式 / 生产模式
npm run dev
npm start
```

> **版本状态**: 核心最小实现已封版定型——`npm run typecheck`, `npm run build` 均已通过, `npm test` 全部 6 个测试文件（25 个测试用例）全绿通过。

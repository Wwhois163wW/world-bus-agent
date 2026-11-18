# tools.ts 伴生澄清文档

## 1. 技术设计要点 / 总结

- **工具集合**: `createNativeWorkspaceTools(bus)` 为智能体提供 5 个受限工作区工具：`read_file`, `write_file`, `list_dir`, `exec_cli`, `emit_event`。
- **路径沙箱**: `resolveSafePath` 强制将文件读写与目录列举限制在 `bus.workspaceDir` 内部, 拦截 `../` 等路径越界访问并返回 `{ ok: false, error }` 而不中断进程。
- **零静默命令行执行**: `exec_cli` 在工作区目录执行本地 CLI / 脚本, 非 0 退出码时返回完整 `exitCode`, `stdout`, `stderr`。
- **防自激铁律**: `emit_event` 在向本机 `bus.nodeId` 或全局广播 `"*"` 发送事件时, 强制将 `wake` 压制为 `false`, 防止女仆向自身死循环唤醒；仅发往远端节点时保留 `wake` 标志。

---

## 2. 变更记录流水

### [2026-11-18] @Antigravity, 20261118, [FIX]: 对齐 ai@6 tool() 接口定义
- **修改原因**: 项目安装了 `ai@^6.0.0`, 其 `tool()` 工厂函数使用 `inputSchema` 替代了早期版本的 `parameters`, 导致 `tsc` 编译报错参数隐式 `any` 及 `execute` 重载不匹配。
- **修改内容**: 按非破坏性编辑原则将 5 个工具定义中的 `parameters:` 行注释保留, 并在下方改为 `inputSchema:`。

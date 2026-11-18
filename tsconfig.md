# tsconfig.json 伴生澄清文档

## 1. 技术设计要点 / 总结

- **编译目标与模块体系**: 采用 `ES2022` 与 `NodeNext` (`module` / `moduleResolution`), 与 `package.json` 的 `"type": "module"` 保持一致。
- **类型安全**: 开启 `strict: true` 与 `declaration: true`, 输出目录为 `dist/`, 源码根目录为 `src/`。
- **当前状态**: 本文件本次未作语法修改, 作为根目录配置文件伴生归档；待 `src/` 内旧版残留文件清理及类型修复后, `npm run build` 即可正常通过。

---

## 2. 变更记录流水

### [2026-11-18] @Antigravity, 20261118, [DOCS]: 补建 tsconfig.json 伴生澄清文档
- **修改原因**: 补全根目录配置文件伴生文档。
- **修改内容**: 无代码变更, 归档当前编译选项设计说明。

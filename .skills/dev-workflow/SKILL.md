---
name: dev-workflow
description: 项目开发工作流规范（文档先行、验证纪律）。当需要在本项目中修改代码/配置/文档、更新功能清单、或完成一次改动验证时使用。
---

# 开发工作流

本项目任何代码、配置、文档改动都必须遵守以下纪律。

## 核心铁律

1. **文档先行**：先更新设计文档（功能设计 / 详细设计 / 插件契约），再写代码；文档是活的契约，代码与文档冲突时更新文档而非放任不一致。
2. **功能清单**：完成功能后更新 `docs/功能清单列表.md` 对应条目状态（✅/◐/⏸）。
3. **交互粒度**：功能设计中的交互描述必须写到「操作 → 页面跳转 → 反馈」粒度，禁止概述式描述。
4. **变更留痕**：CHANGELOG.md / CHAT.md 的写入规范（只增不改、时间精确到年月日时分秒）见 `record-changes` 技能。

设计文档体系与编写规范（各文档职责、契约演进）见 `architecture-design` 技能。

## 完成标准（验证纪律）

改动完成前必须全绿：`pnpm typecheck`（node + web）、`pnpm lint`（0 error）、`pnpm test:unit`、`pnpm build`；UI 类改动用临时 Vite 工程 + Playwright 断言验证。

测试与验证的详细规范与**留存纪律**见 `test-verification` 技能；验证产物归档在 `tests/verification/`（脚本、数据、记录）。

## 注意事项

- typecheck 与 build 要**串行**执行：并行时 build 会重写 `components.d.ts`/`auto-imports.d.ts`，造成 vue-tsc 读到半成品而假报错。
- 详细契约与规范在项目 `docs/` 下，本技能不重复内部细节；动手前先读对应文档。

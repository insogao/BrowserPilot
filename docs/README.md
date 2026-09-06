---
type: DocumentationIndex
status: stable
generated: { by: codex, at: 2026-09-03T11:20:00+08:00 }
stale_after: 2026-12-03
---

# BrowserPilot 文档总索引

这是仓库内的唯一文档入口。根目录 `AGENTS.md` 只负责把任何新 AI 引到这里，不承载重复规则。

## AI Project Owner

按顺序读取：

1. [owner/START-HERE.md](owner/START-HERE.md) — 接管步骤和本次任务路由。
2. [owner/CONSTITUTION.md](owner/CONSTITUTION.md) — 权限、红线、完成定义。
3. [owner/WORKFLOW.md](owner/WORKFLOW.md) — 分派、执行、验收、收尾流程。
4. [owner/ROLES.md](owner/ROLES.md) — Owner、核心维护者、站点 Adapter、Reviewer 的边界。
5. [owner/NEXT-SESSION.md](owner/NEXT-SESSION.md) — 当前真实进度和下一步。

按需读取：

- [owner/ARCHITECTURE.md](owner/ARCHITECTURE.md) — 修改核心代码或调度框架前读取。
- [owner/QUALITY-GATES.md](owner/QUALITY-GATES.md) — 验收命令和证据格式。
- [owner/STRUCTURE.json](owner/STRUCTURE.json) — `npm run doctor` 使用的机器清单。
- [handover/opencode-agents.md](handover/opencode-agents.md) — 外部 Opencode 会话台账。

## 开发与模板

- [dev/task-spaces.md](dev/task-spaces.md) — Task Space、所有权和前台串行机制。
- [../registry/templates/README.md](../registry/templates/README.md) — 站点适配 Agent 的唯一工作规范与真实 smoke 要求。
- [../registry/INDEX.md](../registry/INDEX.md) — 全部模板一览（自动生成，按分类分组）。
- [../registry/README.md](../registry/README.md) — Registry 协议和发布侧说明。
- [../scripts/site-regression-plan.json](../scripts/site-regression-plan.json) — 支持站点和回归顺序的机器清单。

## 事实优先级

运行中的代码与可复现测试证据高于里程碑文字。若文档与代码冲突，先记录 `sync_required`，由核心维护者核对代码并更新文档；不得为了让文档“看起来正确”而改低测试门槛。

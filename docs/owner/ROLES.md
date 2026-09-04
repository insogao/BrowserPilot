---
type: RoleRegistry
status: stable
generated: { by: codex, at: 2026-09-03T11:20:00+08:00 }
stale_after: 2026-12-03
---

# 角色与权限

| 角色 | 模式 | 主要职责 | 写权限 | 主要工具/规范 |
|---|---|---|---|---|
| AI Project Owner | singleton | 定方向、拆任务、分派、验收、更新交接 | 框架与文档，按任务收敛 | `START-HERE`、`WORKFLOW`、`QUALITY-GATES` |
| Core maintainer | singleton | 插件、Host、协议、Task Space、公共 primitive、测试框架 | `src/`、`native-host/`、`scripts/` 与相关文档 | `ARCHITECTURE`、`docs/dev/*`、npm 测试 |
| Site Adapter | serial browser worker | 单站点页面观察、模板修改、真实 smoke | 仅 `registry/templates/<id>/` | `registry/templates/README.md`、BrowserPilot client |
| Template Reviewer | parallel read-only | 合同、重复功能、schema、产品体验审查 | 默认无 | Registry 文档与只读命令 |
| Integration reviewer | singleton | 跨层 diff、生成物、回归门禁 | 默认无；发现问题回派 | `QUALITY-GATES` |

## 外部 Agent

Opencode + `opencode-go/mimo-v2.5` 是低成本合同方，由 `scripts/run-adapter-agent-queue.mjs` 串行调用。它只获得任务合同和仓库权限，不拥有提交、推送、发布权。会话台账在 `docs/handover/opencode-agents.md`。

## 角色升级规则

默认一个共享 Core maintainer，加按任务创建的 Site Adapter。只有站点反复破坏、价值高或拥有独特登录/虚拟列表/媒体流程时，才保留长期专属 Adapter 会话。全局拟人化与节流属于 Core，不由各站点自行发明。


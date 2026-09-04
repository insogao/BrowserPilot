---
type: Workflow
status: stable
generated: { by: codex, at: 2026-09-03T11:20:00+08:00 }
stale_after: 2026-12-03
---

# Project Owner 工作流

## 主流程

| 阶段 | Owner 动作 | 执行者 | 产物 | QA 门禁 |
|---|---|---|---|---|
| 1. 定位 | 从代码、测试、日志确认事实 | Owner / Reviewer | 问题归属与状态 | `git status`、现有测试、真实错误 |
| 2. 设计 | 判断属于核心还是单站点模板 | Owner | 有边界的任务合同 | `ARCHITECTURE.md` 与写权限不冲突 |
| 3. 分派 | 给 Agent 明确目录、命令、完成格式 | Owner | Agent 任务 | 每个任务只有一个写 owner |
| 4. 执行 | 改代码或模板并自检 | Maintainer / Adapter | 受限改动 | Worker 自检通过 |
| 5. 验收 | 审查 diff 与机器证据 | Owner / Reviewer | passed/failed/blocked 判定 | `QUALITY-GATES.md` |
| 6. 集成 | 生成 Registry、跑全局检查 | Core maintainer | 可集成工作树 | 类型、核心、Host、Registry 全绿 |
| 7. 收尾 | 重写当前交接并报告 | Owner | `NEXT-SESSION.md` | `npm run doctor` |

## 并发规则

- 可并行：只读代码审查、schema 检查、文档审查、互不重叠的非浏览器测试。
- 必须串行：同一 Chrome profile 上的页面适配、截图、DOM 探测、真实 smoke。
- 自动串行入口：`npm run agents:queue -- <template-id> [template-id...]`。
- Finance 专项重派：`npm run agents:finance`。
- 全站回归：`npm run agents:regression`；所有产品站点均按动态模板 Adapter 串行工作。Google Search、ChatGPT、Gemini 的扩展内置版本只作卸载/禁用动态包后的离线兜底。
- Finance 已单独验收后继续其余站点：`npm run agents:regression:remaining`，避免重复派发 Finance。
- 将仍写死在扩展源码里的站点模板迁移为动态包：`npm run agents:migrate-builtins`。每个 Agent 仍只写 `registry/templates/<id>/`，不得修改核心源码；内置版本仅作离线兜底。
- 队列成功条件：Agent 进程退出 0、机器结果为 `passed`、自动清理无错误。`blocked` 和缺少机器报告都会让队列整体非零，但后续任务仍会继续。
- Agent 主动交给用户的 Task Space 不会被队列关闭；其他该 Agent 创建的活动临时空间在任务后自动清理。

## Adapter 合同

任务提示必须包含：唯一模板 ID、唯一可写目录、必须先读的规范、真实 smoke 命令、阻断处理、机器结果行。标准队列会自动生成合同。手工分派时最后一行必须为：

```text
BROWSERPILOT_ADAPTER_RESULT {"status":"passed|failed|blocked","smokeCommand":"...","evidence":"...","nextAction":"..."}
```

`passed` 的 evidence 必须包含最终 smoke 返回的有效结果数量或站点特定断言。仅写“看起来正常”不合格。

支持站点不在文档中手工维护另一份列表，唯一机器清单是 `scripts/site-regression-plan.json`。查看计划用 `npm run agents:regression:plan`。

## 故障路由

- selector、页面结构、站点步骤：返回同一个 Site Adapter，给独占浏览器轮次。
- `SPACE_*`、`FOREGROUND_BUSY`、Host/端口、队列清理：Core maintainer。
- captcha、限流、登录墙：记为 blocked；不得规避。由 Owner 决定产品降级、等待或用户接管。
- 文档与实现不一致：记为 `sync_required`，以代码和测试证据恢复 CURRENT。

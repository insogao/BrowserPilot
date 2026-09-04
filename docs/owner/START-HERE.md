---
type: OwnerRunbook
status: stable
generated: { by: codex, at: 2026-09-03T11:20:00+08:00 }
stale_after: 2026-12-03
---

# AI Project Owner 接管入口

你的职责是判断、分派、验收和向用户报告，不是亲自承担每个站点的页面适配。项目 Owner 可以修改框架与文档，但站点 bug 应交给对应 Adapter Agent。

## 每次会话启动

1. 读 `CONSTITUTION.md`、`WORKFLOW.md`、`ROLES.md`、`NEXT-SESSION.md`。
2. 执行 `git status --short`，保留并识别已有改动；不得覆盖不属于本任务的工作。
3. 执行 `npm run doctor`，确认文档、命令和模板包结构没有漂移。
4. 若任务涉及核心代码，再读 `ARCHITECTURE.md` 和相关 `docs/dev/*`。
5. 若任务涉及站点模板，让 Adapter 完整读取 `registry/templates/README.md`。
6. 对照 `NEXT-SESSION.md` 选择一个明确结果，分派后按 `QUALITY-GATES.md` 验收。

## 当前任务路由

- 插件核心、Host、Task Space、锁、公共命令：核心维护者。
- 单个网站的 selector、步骤、提取结果：该网站 Adapter，只能改自己的模板目录。
- 多站点静态审查：可并行 Reviewer。
- 真实浏览器测试：单 profile 下必须串行；使用 `npm run agents:queue -- <ids...>`。
- 文档或流程漂移：Project Owner 负责修订，随后运行 `npm run doctor`。

## 会话结束

1. 运行与改动风险相称的测试。
2. 把结果写回 `NEXT-SESSION.md`，整页保持“当前状态”，不要追加流水账。
3. 记录 passed、failed、blocked，不把外部阻断描述成成功。
4. 默认不提交、不推送、不发布；只有用户明确要求才执行不可逆的外部动作。


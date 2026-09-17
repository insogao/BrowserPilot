---
type: ArchitectureBaseline
status: stable
generated: { by: zcode, at: 2026-09-05T00:30:00+08:00 }
stale_after: 2026-12-03
---

# BrowserPilot 架构基线

本页记录从当前代码恢复的事实。修改核心前读取；改动改变事实后必须同步本页，否则状态为 `sync_required`。

## CURRENT

| 事实 | 代码证据 |
|---|---|
| MV3 扩展通过 Native Messaging Host 与本地 CLI 通信 | `src/background/native-bridge.ts`、`native-host/host.js`、`native-host/client.mjs` |
| Host 可在 Windows（SEA exe + 注册表）与 macOS/Linux（node 直跑 wrapper + NativeMessagingHosts 目录）上运行；直跑时 capability token 与 client 共用 `auth.json`，client 经 session 文件免扫描发现运行中 host | `native-host/host.js`、`native-host/paths.js`、`scripts/register-host-mac.mjs` |
| Host 扫描本机动态端口并注入经过校验的稳定 Agent 身份 | `native-host/host.js`、`native-host/client.mjs` |
| 一个 Task Space 对应一个普通 Chrome 窗口；同 profile 共享 cookie | `src/background/spaces.ts`、`docs/dev/task-spaces.md` |
| 扩展层强制 Space 所有权、tab 归属与前台 lease | `spaces.ts`、`tab-resolver.ts`、`foreground-lease.ts` |
| 全部 Registry 模板在 `registry:build` 时打进扩展（`dist/templates.bundle.json`），开箱即用；GitHub Registry 仅用于发现更新/新增，安装后以动态包覆盖同名模板 | `src/background/bundled.ts`、`src/background/templates.ts`、`scripts/build-registry.mjs` |
| 可见性默认“不抢焦点但可见”：`open_space`/`open_tab`/`switch_tab`/`run_template` 默认把窗口建为 normal 可见、不聚焦、不激活到最前（窗口内 Agent 标签保持 active 以正常渲染）；只有显式 `focus:true`/`keepVisible:true`/`visible:true`/`background:false` 才前台最大化。后台运行**完全不触碰**已有窗口状态 | `src/background/spaces.ts`、`src/background/templates.ts` |
| 单 profile 可见浏览器工作串行；仓库 lease 是开发保护，扩展 lease 是产品权限 | `scripts/browser-lease*.mjs`、`foreground-lease.ts` |
| Adapter 自动队列串行启动外部 Agent，并应以语义结果而非退出码判定 | `scripts/run-adapter-agent-queue.mjs` |

## 架构不变量

- 运行时模板和插件核心分离；普通站点适配不得要求重编译扩展。
- Host 才能注入内部 `_clientId` 和 foreground token；外部输入不得伪造。
- 任一 tab 页面操作必须通过调用者拥有且活动的 Space。
- Agent 新建的 Space 默认“可见但不抢焦点”（normal、不激活到最前），不得抢占用户桌面前台；只有显式可见请求才允许前台最大化，且可见性恢复不得把已最大化窗口降回普通小窗口。后台运行不得恢复/改变已有窗口状态（macOS 恢复最小化窗口会置前，实测为弹窗来源）。
- 页面能力差异（滚动/惰性加载/按 `visibilityState` 分流 UI）不得以“弹窗到前台”为默认代价：后台空间内保持 Agent 标签在窗口内 active，使页面按可见态渲染。
- 用户接管优先于 Agent；用户拥有的 Space 不自动清理。
- 同 profile 的可见浏览器动作只能有一个执行者。
- 媒体字节不以内嵌大 base64 穿过模板定义；使用下载通道。

## 所有权映射

- 连接/身份：`native-host/host.js`。
- 客户端发现/启动策略：`native-host/client.mjs`。
- Space 生命周期：`src/background/spaces.ts`。
- 持久状态：`src/background/state.ts`。
- 前台互斥：`src/background/foreground-lease.ts`。
- 模板解释器：`src/background/templates.ts`。
- 开发浏览器队列：`scripts/browser-lease*.mjs` 与 `run-adapter-agent-queue.mjs`。
- 单站点行为：`registry/templates/<id>/template.json`。

## TARGET 与 GAP

- TARGET：独立 Agent Pool 可按需分配独立 Chrome 进程/profile/Host，提供更强隔离。
- GAP：当前不共享登录态的多进程方案成本高，尚未实现；默认仍是单 profile 串行。
- TARGET：全局 `set_humanize` 提供统一、可审计的节奏策略。
- GAP：当前仅保留命令名，模板需使用有界 wait/type/scroll，不能声称全局拟人化已完成。
- TARGET：每个队列任务都输出结构化状态和可持久化证据。
- GAP：2026-09-03 之前的 Agent 日志只有自然语言摘要；新队列协议开始使用机器结果行。

## ADR

- ADR-001：采用普通 Chrome 上的逻辑 Task Space，不声称 Chromium BrowserContext 级隔离。
- ADR-002：真实页面任务单 profile 串行，静态审查可并行。
- ADR-003：模板随扩展发布（bundle），GitHub Registry 只负责更新/新增发现；运行时安装仍保留用于覆盖与第三方模板。
- ADR-004：Adapter 只改自己的模板包；公共能力缺口回派 Core maintainer。
- ADR-005：后台优先于可见——默认后台执行与验证，前台是需要显式声明的例外（AI 聊天等确实要求前台渲染的模板自行声明）。

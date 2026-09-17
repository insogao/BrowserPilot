---
type: QualityPlaybook
status: stable
generated: { by: codex, at: 2026-09-03T11:20:00+08:00 }
stale_after: 2026-12-03
---

# 质量门禁

## 文档与结构

```powershell
npm run doctor
git diff --check
```

## 核心框架

```powershell
npm run typecheck
npm run test:core
npm run test:host
npm run test:host:exe
```

涉及 macOS native host 注册（`scripts/register-host-mac.mjs`、Chrome for Testing / 自定义 user-data-dir 目标）时追加 `npm run test:register`。
涉及 profile 探测时追加 `npm run test:profile`。涉及构建产物时追加 `npm run build` 和 `npm run build:host`。

## Registry 静态门禁

维护者运行：

```powershell
npm run registry:build
npm run registry:check
```

Adapter 不运行 build、不手改 catalog/details。最终用户也不需要这些命令。

## 真实站点门禁

```powershell
npm run smoke:template -- <template-id>
npm run smoke:template -- --visible <template-id>   # 仅在用户明确要看、或排查渲染差异时使用
```

`smoke:template` 默认**后台运行**：复用同一个常驻专用 `BrowserPilot Smoke` 窗口（可见但不聚焦、不弹到前台；窗口内 Agent 标签保持 active 以正常渲染），每个模板在同一窗口开标签页、测完自动关闭；`--visible` 才把窗口激活到最前，`--fresh` 跑完关闭窗口。选取是 fail-closed：枚举/复用/置前失败时直接报错、**不新建窗口**；只有枚举成功且无专用候选、或扩展明确回报 `SPACE_INACTIVE`（窗口已被确认为消失）才重建窗口。

通过证据必须同时具备：

- `install_template` 为 true。
- `run_template` 为 true。
- `tests/smoke.json` 的站点特定断言满足。
- 输出不是登录墙、验证码、限流或反自动化提示。
- Agent 报告准确的 `passed|failed|blocked`，并给出最终命令和证据。

批量队列用于依次交给站点 Agent：

```powershell
npm run agents:queue -- <id-a> <id-b>
```

检查 `.browserpilot-runs/<timestamp>/summary.json` 中的 `semanticStatus`，不能只看 `exitCode`。

完整站点回归：

```powershell
npm run agents:finance          # 仅重新派发 Google Finance
npm run agents:regression       # 所有动态站点 Adapter（收尾自动跑 registry:check）
npm run agents:regression:remaining # Finance 之后的动态站点 Adapter
npm run agents:migrate-builtins # 把 search/chatgpt-ask/gemini-ask 迁为免编译动态包
npm run agents:regression:plan  # 只查看站点与顺序，不打开浏览器
```

注意：`agents:regression` 只覆盖动态包。全部 31 个 Registry 模板都随扩展发布（`dist/templates.bundle.json`），`smoke:template` 会先用仓库包 `install_template` 覆盖同名 bundled 版本再跑，因此测到的是当前仓库版本；要回归 bundled 兜底版本，先 `uninstall_template` 卸载对应动态包，再 `npm run smoke:template -- <id>`（此时走 `import_template` + `tests/site-smoke/<id>.json` 契约）。

当前产品登记 8 个站点工作流：Google Search、百度、Bing、X、Google Scholar、Google Finance、ChatGPT、Gemini。全部以动态包作为站点更新入口，且全部随扩展发布。`search-demo` 是开发示例，参加兼容回归但不重复计算站点；`browserpilot-example-prompt` 不操作网页，只参加静态 Registry 检查。

## 发布门禁

只有用户明确要求时才提交或推送。提交前应确保工作树中的改动归属明确，所有相关门禁通过，`NEXT-SESSION.md` 与真实状态一致。被第三方阻断的模板不得写成 stable/passed。

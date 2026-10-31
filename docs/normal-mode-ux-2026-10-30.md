# 正常浏览模式 vs 自动化模式（2026-10-30）

## 结论

用户正常浏览被 Google/百度拦截，不是“必须改指纹绕过风控”，而是**正常启动路径带了
ChromeDriver 的自动化标记**：

- Chromium 源码 `content/child/runtime_features.cc` 明确：命令行带
  `--remote-debugging-port=0` 时，会启用 `EnableAutomationControlled`，网页看到
  `navigator.webdriver === true`。这是 ChromeDriver 启动浏览器的约定。
- 实测（`--remote-debugging-port=0` + managed 测试窗口）：
  `navigator.webdriver = true`，3 个百度搜索 tab 全部跳到“百度安全验证”。
- 实测（正常模式：持久 profile、无 managed、无 `=0` 端口）：
  `navigator.webdriver = false`，百度搜索正常返回结果，`hasCaptcha=false`；
  新浪财经、东方财富、和讯、财新、中国证券网正常加载。

## EgoLite 的做法（对照）

EgoLite 是 Electron 桌面浏览器：

- 正常浏览使用标准 `BrowserWindow` + **持久化 profile**（`persist:ego-desktop` /
  `persist:ego-profile-*`）；
- 启动参数没有 `--enable-automation`，也没有 `--remote-debugging-port=0`；
- CDP / `webContents.debugger.attach` 只在真正执行自动化动作时临时使用，不作为正常
  浏览的启动状态；
- 因此网站看到的是普通浏览器会话，而不是 ChromeDriver 会话。

结论：正常浏览/自动化必须是两个启动模式，不能把测试/自动化参数带进日常使用。

## Browser CLI 的规则

正常浏览模式：

- 持久 profile（用户自己的 profile；测试用独立但持久的 profile）；
- 不带 `--browser-cli-background-presentation`；
- 不带 `--browser-cli-user-explicit-show`（普通启动直接出窗口）；
- **不带 `--remote-debugging-port=0`**；
- 不带 `--enable-automation` / `--headless`；
- 扩展可以加载，BrowserPilot 通过 native messaging 工作；`chrome.debugger` 只在
  具体命令需要时 attach，不常驻。

自动化/测试模式：

- 需要浏览器级 CDP 时，用**非 0 固定端口**（Chromium 只在 `port=0` 时设置
  `navigator.webdriver`），或者用 DevTools pipe；
- managed/background 测试可以继续用 `--browser-cli-background-presentation`，但要
  明确这是测试，不是用户正常浏览；
- 测试 harness 中 `--remote-debugging-port=0` 是自动化测试标记，不得复制到产品启动器。

不要做：

- 不通过 Canvas/WebGL/UA/时区伪造来绕过 Google/百度的反爬验证；这不是产品修复，
  也不稳定。
- 不把“改指纹”当作正常浏览体验的解决方案；先消除自己注入的自动化标记，使用持久
  profile 和正常窗口。

## 落地

- `D:\work\BrowserPilot\manual-browser.cmd` 已改为正常模式：
  持久 profile `.manual-profile-normal`、`--load-extension`、`--in-process-gpu`、
  `--disable-direct-composition`，**无** managed/user-explicit/remote-debugging 参数。
- 正常窗口实测：百度搜索 `Browser CLI Chromium` 有结果，`navigator.webdriver=false`；
  财经网站 tab 均加载。
- 新增 `scripts/check-normal-launch.mjs` 静态门禁：正常启动器出现
  `--remote-debugging-port=0`、`--enable-automation`、`--headless` 或 managed 测试
  开关时失败。

## 仍待处理

- Google 仍可能因 IP、地区、Chromium 品牌/版本或账号风控拦截；这不是正常模式能保证
  的，不能用指纹伪造规避。
- 生产安装器/快捷方式需要确认不携带 `--remote-debugging-port=0`；正常产品启动不应
  为了调试方便而牺牲用户体验。
- `--in-process-gpu --disable-direct-composition` 是本 dev build 的渲染兼容组合；正式
  发布应修复 GPU 进程/KILLED_BAD_MESSAGE 后再去掉这个临时组合。

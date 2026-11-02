# 真实搜狗 TSF IME 验收（2026-10-30）

## 环境

- Windows 11，默认输入法 override 指向中文（`0804:{E7EA138E-...}`，Sogou）。
- Sogou 安装版本目录 `16.6.0.4207`；`SogouImeBroker`/`SogouCloud` 在运行。
- Browser CLI `out/WinDev`，managed-visible 冷启动窗口（`--browser-cli-user-explicit-show`）。
- 输入注入：真实 OS 鼠标（`SetForegroundWindow` + `SetActiveWindow` + `SetCursorPos` +
  `mouse_event`）与 `WScript.Shell.SendKeys`（系统键盘输入路径，经 TSF 到 Chrome）。
  **没有**用 JS 合成 `KeyboardEvent`/`InputEvent` 或页面脚本写值。

## 用例与结果

Fixture：`tests/fixtures/ime-inputs.html`，三个输入面：

- `<input id="in">`
- `<textarea id="ta">`
- `<div id="ce" contenteditable="true">`

| 检查 | 结果 |
|---|---|
| 真实鼠标点击 input 后获得焦点 | PASS |
| 真实键盘输入 `nihao` + 空格选候选 | PASS（input 值变为中文“你好”） |
| input 退格删除一个字符 | PASS（“你好” → “你”） |
| textarea 真实 TSF 输入中文 | PASS |
| contenteditable 真实 TSF 输入中文 | PASS |
| HUMAN：AI `Input.insertText` 被内核拒绝 | PASS |
| HUMAN：真实人类按键仍可输入 | PASS |
| ASSIST：grant(1) 后第一条 AI `insertText` 落地 | PASS |
| ASSIST：同一 grant 第二条 AI 文本被拒 | PASS |
| HUMAN → 显式 ASSIST 恢复后 AI 文本成功 | PASS |

**IME case 39/39 checks PASS**。真实输入使用 Sogou 候选提交（空格），不是直接写入
中文；退格走真实键盘消息。

## 证据

- 运行：`node scripts/test-input-arbitration-e2e.mjs --stage=kernel --feature=on-visible`
- 报告：`D:\c\logs\input-arbitration-e2e-<timestamp>.json`
- 日志：`D:\c\logs\ime-e2e11.log`（最新一轮 IME 全部 PASS）
- Fixture：`tests/fixtures/ime-inputs.html`

## 已知边界

- K4（human_presence）与 IME 在同一 on-visible 会话中顺序执行；K4 的真实鼠标点击在
  个别轮次未落地（`human.landed=false`），单独跑 K4 时 29/29 PASS。这是测试窗口
  widget/坐标命中的偶发问题，不是 IME 或内核失败；最终回归需复跑并记录。
- 没有对 Sogou 候选窗口做视觉截图断言；通过“空格提交后字段出现中文”证明候选路径，
  不把候选 UI 渲染当作通过条件。
- 测试使用 `WScript.Shell.SendKeys`（真实系统键盘注入）；若 CI 运行在无交互桌面，
  该路径不可用，应标记 BLOCKED，不得改用 JS 事件冒充。
- 未覆盖不同 Sogou 版本/皮肤、五笔/双拼、日文/韩文 IME。

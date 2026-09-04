# Changelog

## 1.2.2

- 修复首次加载时序竞争：`@focus` 替换为自定义表达式，先等待 `document.readyState === 'complete'`，再轮询可见输入框并聚焦，避免在 Bing 脚本未初始化时提交表单。
- 在 `@focus` 步骤前新增 `waitForSelector #sb_form_q` 作为前置守卫。
- 将 `fill` 改为 `type`（逐字输入），确保 Bing 的输入事件处理器被正确触发；在输入与 Enter 之间加入500ms等待。

## 1.2.1

- 修复 `press Enter` 提交失败：为 `press` 命令添加 `selector: "[data-bp-focus]"`，确保按键前重新聚焦搜索框。

## 1.2.0

- 重构为声明式搜索模式：`@focus` 声明 `selectors`，`@results` 声明 `rootSelectors`/`linkSelector`/`minResults`/`limit`/`textLimit`。
- 移除聚焦和结果提取的单体内联 JS，改用框架内置 `searchResultsExpr()`。
- 提交方式改为 `press Enter`（`#sb_form_q` 在 `#sb_form` 内，Enter 可靠触发提交）。

## 1.1.0

- 使用原生 JS 表达式替代 `@focus`/`@results` 占位符，适配必应搜索。
- 搜索框选择器：`#sb_form_q`（textarea）。
- 通过 `#sb_form.submit()` 提交表单。
- 结果抓取使用 `#b_results li.b_algo`，标题为空时回退到 `cite` 元素。

## 1.0.0

- 初始版本：支持必应网页搜索，返回前10条结果。
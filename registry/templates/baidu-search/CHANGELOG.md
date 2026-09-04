# Changelog

## 1.2.0

- 重构为声明式搜索模式：`@focus` 声明 `selectors`，`@results` 声明 `rootSelectors`/`linkSelector`/`minResults`/`limit`/`textLimit`。
- 移除聚焦和结果提取的单体内联 JS，改用框架内置 `searchResultsExpr()`。
- 保留 `#form.submit()` 提交（`#chat-textarea` 在 `#form` 外，`press Enter` 不可靠）。

## 1.1.0

- 使用原生 JS 表达式替代 `@focus`/`@results` 占位符，适配百度新版 chat-input 组件。
- 搜索框选择器优先级：`#chat-textarea` > `textarea[name=wd]` > `#kw`。
- 通过 `#form.submit()` 提交表单（`press Enter` 在 chat-textarea 上不触发表单提交）。
- 结果抓取使用 `#content_left` / `.result` / `.c-container` 作为根容器。

## 1.0.0

- 初始版本：支持百度网页搜索，返回前10条结果。
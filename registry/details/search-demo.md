# Search Demo Template

> A copyable demo for adapting a search engine with runtime template selectors.

- ID: `search-demo`
- 版本: `1.0.0`
- 风险: `read`
- 适用站点: `google.com`
- Intents: `search.web`, `search.demo`
- Capabilities: `fill`, `js`, `open_tab`, `press`, `waitForSelector`
- 功能指纹: `sha256:ffc7fb6858bb2d2dfca7646b86f493cd5604a9996e5d274e7e0aacfb7fc9d7a7`

## 输入

- `query` (string, required): Search keyword

## 输出

- `links` (array): Top result links with title and url.
- `text` (string): Visible text from the result container.

## 发现信息

- Keywords: search, demo, selectors, google
- Aliases: google-selector-demo
- BrowserPilot: `>=0.1.0`

## 详细说明

This package demonstrates how to adapt a search engine without changing BrowserPilot plugin code.

## Adaptation Steps

1. Open the target search engine in Chrome.
2. Use BrowserPilot `snapshot` and, if needed, `js` to identify the search input.
3. Put candidate input selectors into the `@focus` step.
4. Submit a real query and inspect the result page.
5. Put result containers into `rootSelectors`.
6. Keep `linkSelector` broad at first, usually `a`, then narrow it only if irrelevant links dominate.
7. Run the template through `install_template` or the template board.
8. If it overlaps with an existing template, declare `alternatives` or `replaces` in `discovery`.

## Important Boundary

Do not edit `src/background/templates.ts` for a normal search adaptation. The selector configuration belongs in `template.json`.

## Inputs

- `query` (string, required): the search keyword.

## Output

The final step returns:

- `count`
- `links`
- `text`

## Convert To Another Search Engine

Copy this package to `registry/templates/<new-id>/`, then change:

- `id`, `name`, `version`, `description`.
- `open_tab.args.url`.
- `@focus.args.selectors`.
- `waitForURL.args.pattern`.
- `@results.args.rootSelectors`.
- `scope.sites`, `discovery.intents`, `discovery.keywords`, and `discovery.aliases`.

## 权威定义

[`template.json`](../templates/search-demo/template.json)


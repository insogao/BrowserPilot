# Search Demo Template

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

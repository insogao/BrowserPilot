# BrowserPilot Template Registry

公开模板放在 `registry/templates/`，目录索引见 `catalog.json`。

模板至少包含：

- 稳定 `id`
- semver `version`
- `name` / `description` / `category`
- `inputs`
- `steps` 与 `body`
- 可选站点范围 `scope.sites`

插件看板可按 `owner/repo + path + ref` 安装公开 GitHub 模板，随后检查更新、升级或回滚。

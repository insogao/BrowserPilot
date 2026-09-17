# BrowserPilot Template Registry

公开模板按包放在 `registry/templates/<template-id>/`。普通 Chrome 商店用户只有已安装插件，没有源码，不运行 npm、不 build、不改插件目录；模板通过插件看板、`install_template` 或 Registry 安装到 `chrome.storage.local` 后生效。

`catalog.json`、`bundle.json` 与 `details/*.md` 是公开 Registry 的生成物，只由项目维护者或 CI 在发布流程中生成，禁止手改：

```bash
npm run registry:build
npm run registry:check
```

`bundle.json` 会在 `npm run build` 时打进扩展（`dist/templates.bundle.json`）：所有模板随扩展发布、开箱即用；`catalog.json` 供 GitHub Registry 检查更新/新增。

模板至少包含：

- 稳定 `id`
- semver `version`
- `name` / `description` / `category`
- 公共 `tags`（search/finance/video/social/ai/download/news，至少一个；词汇表见 `registry/templates/README.md`）
- `inputs`（列表类模板必须支持 `limit`，见作者规范）
- `steps` 与 `body`
- 可选站点范围 `scope.sites`
- 动态发现元数据 `discovery`：intents / keywords / outputs / risk / aliases / 兼容版本

推荐包结构：

```text
registry/templates/<id>/
  template.json        # 唯一功能真源
  README.md            # 可选长说明
  CHANGELOG.md
  examples/*.json
  tests/*.json
```

生成器会校验 schema、ID、semver、命令 allowlist，并根据 sites/intents/capabilities/inputs/outputs 生成能力指纹；未声明 alternatives/replaces 关系的完全重复模板会让 CI 失败。

插件和静态 skill 通过 `sync_registry` / `search_templates` / `get_template_detail` / `compare_templates` 动态发现模板，不枚举静态模板清单。

适配 agent 的详细边界见 `registry/templates/README.md`。适配 agent 只提交模板包，不修改插件源码，也不要求用户重新编译。

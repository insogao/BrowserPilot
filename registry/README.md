# BrowserPilot Template Registry

公开模板按包放在 `registry/templates/<template-id>/`。`catalog.json` 与 `details/*.md` 都由模板包自动生成，禁止手改：

```bash
npm run registry:build
npm run registry:check
```

模板至少包含：

- 稳定 `id`
- semver `version`
- `name` / `description` / `category`
- `inputs`
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

# BrowserPilot（第一版插件）

把浏览器交给 AI/CLI：安装时一次授权、运行中不再请求权限；外部 AI/CLI 经 native messaging 驱动网页（共用 cookie/登录态）；感知当前 profile 并一键导出使用文档。

当前进度：**M1/M2/M3/M5/M7/M9/M11 已落地**（含内置操作模版 search / gemini-ask / chatgpt-ask，真机验证通过）；M4/M6/M8/M10 见下方。

---

## 目录

```
plugin-v1/
├── manifest.json              # MV3 清单（权限一次性给齐；无 sidePanel；含稳定 key）
├── scripts/
│   ├── build.js               # 打包扩展 → dist/
│   └── build-host.mjs         # 把 native host 打包成单文件 exe（Node SEA）
├── src/
│   ├── background/            # SW：index / native-bridge / commands / state / events / debugger-bridge
│   ├── content/bridge.ts      # 内容脚本（L0 观测，M3 填充）
│   ├── popup/                 # 人工入口（状态 + 接管/复制使用文档/Stop）
│   ├── kernel/                # sandbox 内核（M6）
│   ├── offscreen/             # 承载 sandbox 内核（M6）
│   ├── onboarding/            # 权限说明页
│   └── shared/types.ts        # 命令协议（CLI↔host↔SW 共用）
├── native-host/               # M2 主通道
│   ├── host.js                # native messaging 分帧 + TCP 桥（外部 AI 连入）
│   ├── profile.js             # 读 Chrome 父进程命令行探测 profile
│   ├── host.manifest.json     # host manifest（allowed_origins 用固定扩展 ID）
│   ├── register.ps1           # 写 HKCU 注册表（Chrome + Edge）
│   ├── dist/browserpilot-host.exe  # 打包产物（node scripts/build-host.mjs 生成）
│   └── test-*.mjs             # host / profile 自测
├── assets/icons/
└── dist/                      # 构建输出（Chrome 「加载已解压」指向此目录）
```

---

## 准备

```bash
cd plugin-v1
npm install                 # esbuild / typescript / @types/chrome / postject
npm run build               # 构建扩展 → dist/
npm run build:host          # 构建 native host → native-host/dist/browserpilot-host.exe
npm run register-host       # 注册 com.browserpilot.browseragent（HKCU Chrome+Edge）
```

> 项目内 npm 可能需要走 Node 直调（本机 npm 是 shell shim，被 WSL 转译干扰）：
> `node "<npm 目录>/node_modules/npm/bin/npm-cli.js" install`

---

## 开发热更新（不用每次手动点「重新加载」）

改 `src/` 后自动重建 `dist/` 并触发扩展 SW 重载：

```bash
npm run dev               # watch + 自动 rebuild + 自动 reload 扩展 SW
npm run dev:no-reload     # 只 watch rebuild，不自动 reload
```

原理：`scripts/dev.mjs` 用 `fs.watch` 监听 `src/` → esbuild `context.rebuild()` 重建 → 扫描 `127.0.0.1:47001~47060` 找存活 host → 发 `{"type":"command","name":"reload"}`，SW 里调 `chrome.runtime.reload()` 自动载入最新代码。

> **一次性前提**：首次使用请在 `chrome://extensions` 手动点一次「重新加载」，让它加载含 `reload` 命令的新版。之后 `npm run dev` 即可全自动，无需再手动点。
> 注意：SW reload 会断开 native messaging 连接并重启 host，端口可能变化（重新 `export_guide` 拿最新端口）。

---

## 在 Chrome 加载

1. 打开 `chrome://extensions`，右上角开启「开发者模式」。
2. 点「加载已解压的扩展程序」，选本目录 `dist/`。
3. 固定 ID：`manifest.json` 已带 `key`，扩展 ID 固定为 **`nnollghpaggbcdkkgoieneffnlijinio`**（与 `host.manifest.json` 的 `allowed_origins` 一致）。
   - 首次加载后可在 `chrome://extensions` 核对；若 ID 不一致，用实际 ID 重跑 `register-host`。
4. 重启 Chrome（让 host 注册生效），然后在扩展页点击图标 / 右键「在本页使用 Agent」，SW 会 `connectNative` 拉起 host。

---

## 自测（无需 Chrome）

```bash
npm run typecheck          # tsc --noEmit
npm run test:profile       # profile 解析单测（3 例）
npm run test:host          # host.js：ready 帧 + TCP 命令转发
npm run test:host:exe      # 打包后 exe：同上
```

---

## 外部 AI / CLI 对接

host 监听 `127.0.0.1:<port>`（默认 47001，被占向后扫描），TCP **换行分隔 JSON**。协议（`src/shared/types.ts`）：

- 进：`{"type":"command","name":"ping","args":{},"requestId":"1"}`
- 出：`{"type":"result","requestId":"1","ok":true,"data":{...}}`
- 事件：`{"type":"event","name":"...","args":{...},"sequence":N}`

`host.js` 同时在 `stdout` 用 native messaging 4 字节长度前缀与扩展通信；`ready` 上报 `{port, authToken, profile}`。

推荐直接使用项目自带客户端，它会自动扫描动态端口并读取当前构建的 capability token：

```bash
npm run client -- list_tabs '{}'
npm run client -- snapshot '{"level":"L0","tabId":123}'
```

L0 快照返回 `snapshotId`。后续以 `ref:"@N"` 操作时必须同时传该 `snapshotId`；页面 DOM 变化后旧快照会返回 `page_updated`，避免误点。普通结果只回原请求连接，不再广播给其他本地客户端。

### Template Registry v1

扩展 options 页现提供模板看板，可安装、查阅、启停、检查更新、升级、回滚和卸载模板。支持粘贴 JSON/Markdown，也支持公开 GitHub 仓库的 `owner/repo + path + ref` 来源；仓库可提供 `registry/catalog.json` 供看板读取目录。

命令接口：`install_template` / `list_templates` / `export_template` / `set_template_enabled` / `check_template_update` / `list_template_catalog` / `update_template` / `rollback_template` / `uninstall_template`。旧 `import_template` 保持兼容。

Registry 使用 `browserpilot.templates.v2`，首次读取会自动迁移 v1 本地模板。每条记录包含版本、SHA-256、来源、启用状态、安装/更新时间和一个可回滚 revision。仅模板 JSON/Markdown **定义文件**限制为 1MB；模板引用或任务下载的图片、音频、视频不受此限制，媒体不应以内嵌 base64 塞进模板。模板步骤不能调用 reload、stop 或模板管理命令。

现有 `download_resource` 会在页面上下文取得登录态图片/blob 字节，并在扩展内部交给 downloads API，不把大 base64 塞进 CLI→native messaging 命令，因此保留了原有的大图绕行路径。超大视频建议后续走专门的 CDP `IO.read`/ReadableStream 分块通道，避免整段 data URL 常驻内存。

---

## 当前里程碑

| 阶段 | 状态 |
|---|---|
| M1 骨架（manifest/SW/popup/三入口） | ✅ |
| M2 native host 通道 + profile 探测 | ✅（协议与 profile 已自测；待 Chrome 实测对接） |
| M3 L0 观测（markdown 树 + data-id） | ✅ |
| M4 L1 attach + AX 快照 + @N | ⬜ |
| M5 动作全集 + js()/waitFor + 导航版本 | ✅ |
| M6 sandbox 内核（run_script 脚本型） | ⬜（骨架已留） |
| M7 Task Space 浏览器级接管（list_tabs + tabId 跨标签 + 缺省当前激活标签） | ✅ |
| M8 profile 使用文档导出 + onboarding 文案 | ✅（含 host capability token） |
| M9 插件化操作模版（import/run + failback，省 token 驱动，内置 search/gemini-ask/chatgpt-ask；含追问 URL 锚定 `@verifyConv` + 图片 `@chatCollect` 多图全收〔Gemini Choice A/B〕+ `download_resource`〔通道 B：blob canvas 全尺寸 / 登录态 http 页面 fetch / `urls[]` 一次下多张自动编号，文件名可控〕，均已实现并真机闭环测试） | ✅ |
| M10 模拟人工防限流（set_humanize + botCheck） | ⬜ |
| M11 人工接管遮罩（start_mask / stop_mask / mask_takeover） | ✅ |

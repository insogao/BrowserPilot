# BrowserPilot（第一版插件）

把浏览器交给 AI/CLI：安装时一次授权、运行中不再请求权限；外部 AI/CLI 经 native messaging 驱动网页（共用 cookie/登录态）；感知当前 profile 并一键导出使用文档。

当前进度：**M1/M2/M3/M5/M7/M9/M11 已落地**（含全部 Registry 模板随扩展发布、Tag 分类与 `limit`/自动翻页，真机验证通过）；M4/M6/M8/M10 见下方。

---

## 目录

AI Project Owner 或新维护者先读 [`AGENTS.md`](AGENTS.md)；完整文档索引位于 [`docs/README.md`](docs/README.md)。

```
plugin-v1/
├── manifest.json              # MV3 清单（权限一次性给齐；无 sidePanel；含稳定 key）
├── scripts/
│   ├── build.js               # 打包扩展 → dist/
│   └── build-host.mjs         # 把 native host 打包成单文件 exe（Node SEA）
├── src/
│   ├── background/            # SW：index / native-bridge / commands / state / events / debugger-bridge
│   ├── content/bridge.ts      # 内容脚本（L0 观测，M3 填充）
│   ├── popup/                 # 人工入口（连接状态 + 人工接管/恢复 + Copy Skill + 模板管理）
│   ├── kernel/                # sandbox 内核（M6）
│   ├── offscreen/             # 承载 sandbox 内核（M6）
│   ├── onboarding/            # 权限说明页
│   └── shared/types.ts        # 命令协议（CLI↔host↔SW 共用）
├── native-host/               # M2 主通道
│   ├── host.js                # native messaging 分帧 + TCP 桥（外部 AI 连入）
│   ├── profile.js             # 读 Chrome 父进程命令行探测 profile
│   ├── host.manifest.json     # host manifest（allowed_origins 用固定扩展 ID）
│   ├── paths.js               # host/client 共享的本机 session 目录
│   ├── register.ps1           # Windows：写 HKCU 注册表（Chrome + Edge）
│   ├── dist/browserpilot-host.exe  # Windows 打包产物（node scripts/build-host.mjs 生成）
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
npm run build:host          # Windows：构建 native host → native-host/dist/browserpilot-host.exe
npm run register-host       # Windows：注册 com.browserpilot.browseragent（HKCU Chrome+Edge）
```

macOS 无需 build:host：注册脚本生成一个用本机 node 直跑 `host.js` 的 wrapper（token 与 client 共用 `auth.json`）：

```bash
npm run register-host:mac   # 自动发现已安装的 Chrome / Chrome for Testing / Chromium / Edge / Brave，写入其 NativeMessagingHosts/
```

Chrome for Testing 与普通 Chrome 一样按用户数据目录查找用户级 host：带自定义 `--user-data-dir` 启动时（自动化、克隆浏览器等），manifest 必须放在 `<user-data-dir>/NativeMessagingHosts/`。用 `--user-data-dir` 显式声明目标即可，任意品牌通用，脚本不会扫描运行中的进程或写入其它 profile。默认它是**追加**目标（同时注册自动发现的浏览器目录）；加 `--only-user-data-dir` 则只注册给出的目录，绝不触碰自动发现目录，且必须至少给出一个 `--user-data-dir`：

```bash
node scripts/register-host-mac.mjs --user-data-dir "/path/to/user data"
node scripts/register-host-mac.mjs --only-user-data-dir --user-data-dir "/path/to/user data"   # 只写该目录
npm run register-host:mac -- --only-user-data-dir --user-data-dir "/path/to/user data" --dry-run
npm run register-host:mac -- --unregister --only-user-data-dir --user-data-dir "/path/to/user data"
npm run register-host:mac -- --dry-run        # 只打印将注册的目标，不写文件
npm run register-host:mac -- --unregister     # 只清理由本脚本写入的 manifest/wrapper
```

Backlight 默认 profile 的实测定向注册（只写该目录）：

```bash
npm run register-host:mac -- --only-user-data-dir \
  --user-data-dir "$HOME/Library/Application Support/Backlight/spaces/default/profile"
```

> **生效方式（2026-09-16 实测）**：native host 注册在目标 user-data-dir 上**不需要为生效而重启浏览器**——注册后扩展直接 `connectNative` 即可连通（Backlight 默认 profile 未重启即 `ping` 成功）。需要重载的是**扩展本身**：刚加载或更新 `dist/` 后在 `chrome://extensions` 点一次「重新加载」（或走 `npm run dev` 热更新流程）。首次安装（`onInstalled` reason=install）扩展会自动打开 onboarding/使用说明页。新 Backlight space 的 profile 需要单独定向注册，注册不会自动扩散。

> 重复执行是幂等的（内容相同不重写）；目标位置已存在不属于 BrowserPilot 的 manifest/wrapper 时默认拒绝写入，确认后才用 `--force` 覆盖。

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
4. 让连接生效：native host 注册在目标 user-data-dir 上**无需重启浏览器**（2026-09-16 实测）；若刚加载/更新了扩展代码，先在 `chrome://extensions` 重新加载扩展。然后点一次扩展图标，SW 会 `connectNative` 拉起 host，并缓存当前 profile，供官方 client 后续自动启动。首次安装会自动打开 onboarding 页。

---

## 当前安装与验证（2026-09-16 实测，macOS）

- 宿主：Backlight 默认实例（daemon pid 2695 / `http://127.0.0.1:9333`；品牌 Chrome for Testing 153.0.8010.47），user-data-dir `/Users/jiangao/Library/Application Support/Backlight/spaces/default/profile`（当前唯一 space `default`）。
- 扩展：本 worktree `dist/` 已被加载，ID `nnollghpaggbcdkkgoieneffnlijinio`、版本 0.1.0、runtime `enabled=true`（`curl -s http://127.0.0.1:9333/api/extensions`）；首次加载自动打开了 onboarding 页。
- native host：定向注册在默认 profile 的 `NativeMessagingHosts/`，wrapper 指向本 worktree 的 `native-host/dist/host-mac.sh`；host 是品牌浏览器进程的直接子进程，监听 `127.0.0.1:47001`。
- 验证（无浏览器启动）：`npm run client -- ping '{}' --no-launch` → `pong: true`；`npm run client -- list_templates '{}' --no-launch` 返回全部 31 个随扩展发布的 bundled 模板（带 `tags`；2026-09-17 起不再只含 3 个编译内置），未安装动态包。注册与连接在浏览器未重启时生效。
- 边界：新 Backlight space/profile 需重新定向注册；本 worktree 路径变化会同时破坏已加载扩展与 host wrapper 指向，迁移后需 `bl ext` reload + 重注册。

## 验证顺序（macOS，保留登录态）

1. 静态门禁（不启动浏览器）：`npm run doctor`、`npm run typecheck`、`npm run test:core`、`npm run test:host`、`npm run test:profile`、`npm run test:register`、`npm run registry:check`。
2. 只读链路（host 离线时不会拉起浏览器）：`npm run client -- ping '{}' --no-launch`、`npm run client -- list_templates '{}' --no-launch`。
3. 非登录模板 smoke（需用户授权；会操作 live 页面并可能写入动态包）：`npm run smoke:template -- <id>`；先用 list_templates 区分内置与动态包。
4. 需登录站点仅在用户确认该 profile 已登录后测试；不得清 profile 或换临时 user-data-dir 重登。
5. 写入/下载类测试单独授权、限定样本并清理产物；站点首次出现风控即全停。

---

## 自测（无需 Chrome）

```bash
npm run typecheck          # tsc --noEmit
npm run test:profile       # profile 参数解析 + macOS 可执行路径探测单测
npm run test:register      # macOS native host 注册：目标发现/幂等/冲突拒绝/自定义 user-data-dir/仅显式目标
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

推荐直接使用项目自带客户端，它会自动扫描动态端口、读取当前构建的 capability token；若 host 不在线，会尝试启动上次缓存的浏览器 profile：

```bash
npm run client -- list_tabs '{}'
npm run client -- snapshot '{"level":"L0","tabId":123}'
```

L0 快照返回 `snapshotId`。后续以 `ref:"@N"` 操作时必须同时传该 `snapshotId`；页面 DOM 变化后旧快照会返回 `page_updated`，避免误点。普通结果只回原请求连接，不再广播给其他本地客户端。

### Template Registry v1

扩展 options 页现提供模板看板，可安装、查阅、启停、检查更新、升级、回滚和卸载模板。支持粘贴 JSON/Markdown，也支持公开 GitHub 仓库的 `owner/repo + path + ref` 来源；仓库可提供 `registry/catalog.json` 供看板读取目录。

命令接口：`install_template` / `list_templates` / `export_template` / `set_template_enabled` / `check_template_update` / `list_template_catalog` / `update_template` / `rollback_template` / `uninstall_template`。旧 `import_template` 保持兼容。

Registry 使用 `browserpilot.templates.v2`，首次读取会自动迁移 v1 本地模板。每条记录包含版本、SHA-256、来源、启用状态、安装/更新时间和一个可回滚 revision。仅模板 JSON/Markdown **定义文件**限制为 1MB；模板引用或任务下载的图片、音频、视频不受此限制，媒体不应以内嵌 base64 塞进模板。模板步骤不能调用 reload、stop 或模板管理命令。

### Registry Protocol v1.1

静态 skill 不再维护完整模板名单。模板包的 `template.json` 是单一真源，`npm run registry:build` 自动生成 `registry/catalog.json` 和 `registry/details/*.md`；`npm run registry:check` 校验 schema、生成物和功能指纹重复。运行时通过 `sync_registry`、`search_templates`、`get_template_detail`、`compare_templates` 动态发现与去重。

现有 `download_resource` 会在页面上下文取得登录态图片/blob 字节，并在扩展内部交给 downloads API，不把大 base64 塞进 CLI→native messaging 命令，因此保留了原有的大图绕行路径。超大视频建议后续走专门的 CDP `IO.read`/ReadableStream 分块通道，避免整段 data URL 常驻内存。

---

## 当前里程碑

| 阶段 | 状态 |
|---|---|
| M1 骨架（manifest/SW/popup/三入口） | ✅ |
| M2 native host 通道 + profile 探测 | ✅（协议/profile 自测 + macOS 真机对接；2026-09-16 Backlight 默认 profile 实测） |
| M3 L0 观测（markdown 树 + data-id） | ✅ |
| M4 L1 attach + AX 快照 + @N | ⬜ |
| M5 动作全集 + js()/waitFor + 导航版本 | ✅ |
| M6 sandbox 内核（run_script 脚本型） | ⬜（骨架已留） |
| M7 Task Space 所有权（Agent 身份 + 独立窗口 + tab 归属 + 人工交接 + 前台串行） | ✅ |
| M8 profile 使用文档导出 + onboarding 文案 | ✅（含 host capability token） |
| M9 插件化操作模版（import/run + failback，省 token 驱动；全部 31 个 Registry 模板随扩展发布并带 7 个公共 Tag，`limit`/`maxPages` 参数化 + SERP 自动翻页 + 滚动收敛；含追问 URL 锚定 `@verifyConv` + 图片 `@chatCollect` 多图全收〔Gemini Choice A/B〕+ `download_resource`〔通道 B：blob canvas 全尺寸 / 登录态 http 页面 fetch / `urls[]` 一次下多张自动编号，文件名可控〕，均已实现并真机闭环测试） | ✅ |
| M10 模拟人工防限流（set_humanize + botCheck） | ⬜ |
| M11 人工接管遮罩（start_mask / stop_mask / mask_takeover） | ✅ |

---
type: SessionHandoff
status: stable
generated: { by: zcode, at: 2026-09-07T02:40:00+08:00 }
stale_after: 2026-09-19
---

# 下一会话交接

更新时间：2026-09-05 02:30 +08:00

## 当前结论

macOS 适配完成且真机全链路已验证（扩展已由用户加载，host 由 Chrome 拉起，命令往返正常）。随后按 code review 清单完成 13 项修复，全部逐项验证。本仓库继续在 macOS 开发；Windows 部署链保留未动。

**真实 smoke（2026-09-05 mac 真机）**：

| 模板 | 状态 | 证据 |
|---|---|---|
| `search` | passed | 10 条结果，UI 链接已被 excludeUrlPrefixes 过滤；mac 区域版 Google 结果链接为 `/goto?url=` 跳转形态（真实结果，非 UI 噪音） |
| `search-demo` | passed | 10 条结果 |
| `bing-search` | passed ×4 连续 | flaky 根因已修（见下）；修复前复现为"首跑失败、重跑成功" |
| `bilibili-search` | passed | 新增站点 v1.0.2：卡片级抓取（标题/作者/链接），39 条去重结果；B站卡片 DOM 有变体，标题优先 `.bili-video-card__info--tit`、兜底滤封面文本 |
| `bilibili-download-video` | passed | 新增站点 v1.0.2：playurl HTML5 单文件 MP4 真实落盘 9.3MB/58.8MB 两轮；清晰度随B站风控浮动 360P~720P，文件名后缀为真实档位 |
| `xueqiu-search` / `xueqiu-article` | passed | 新增 v1.0.0：搜索帖流（作者/时间/链接/摘要+股票行情卡）+ 帖子全文（.article__bd__detail）；需雪球登录态 |
| `guba-search` / `guba-article` | passed | 新增 v1.0.0：so.eastmoney.com/tiezi/s 搜索（.article_item）+ 帖子正文（#newscontent）；免登录 |
| `jiuyangongshe-search` / `jiuyangongshe-article` | passed | 新增 v1.0.0：固定 token 搜索路径 + .detail-container 正文；需微信登录态，积分内容只返回可见部分 |
| `chatgpt-ask` / `gemini-ask` / `x-search` / `baidu-search` / `google-finance-search` / `google-scholar-search` | 未重测 | 上次真实证据仍以 2026-09-04（Windows）为准；scholar/gemini 保持 blocked |

## 2026-09-05 修复清单（全部已验证）

1. **debugger attach 自愈**（P1）：`attach()` catch "already attached" 后发探针命令区分自身遗留与外部调试器；SW 回收后动作命令不再永久失败。新增 core 测试。
2. **前台租约自占用文案**：同 Agent 并发第二命令报 FOREGROUND_BUSY 时明确"同一 Agent 有命令正在使用前台"，不再误称"其他 Agent"。core 测试覆盖。
3. **takeover 接管锁持久化**：`state.humanTakeoverTabIds` + `restoreMaskState()`（SW 启动时由 registerMaskHandlers 恢复）；SW 重启后"人工接管"不丢失。core 测试模拟重启验证。
4. **模板结构化断言 `expectations`**：`path/equals/includes/min/exists` 点路径断言（`template-schema.checkStepExpect`），旧 `expect` 子串兼容保留；`validateTemplate` 校验形状。内置 search 的 `expect:"true"` 已升级。core 测试覆盖弱断言误判场景。
5. **host.js 加固**：token 常数时间比较；requestId 原样回传（对象型不再互相串扰）；pending 上限 512。
6. **install_template content 1MB 上限**（此前只约束 fetch 路径）；`drainEvents` 返回 `generation`（SW 重启可检测游标失效）；移除 `getHostPort` 死代码；`loadInstalled` v1→v2 迁移并发防护。
7. **smoke-template 超时对齐**：run_template 外层 180s→600s（与 client 内部一致），超时报错带最后 300 字符输出。
8. **run-site-regression 收尾自动 `registry:check`**：Adapter 改模板后 catalog 过期会在回归中直接暴露（此前"全绿回归"后 check 仍红）。
9. **stop 作用域语义**：Agent 身份调用只清自己的空间/租约/遮罩/attach（且仅在自己持有前台租约时取消模板运行代际）；popup/options（browserpilot-internal）保持全局清理。源码断言测试 + guide 文案更新。
10. **QUALITY-GATES 漂移修正**：明确 `agents:regression` 只覆盖动态包；内置兜底回归需先 `uninstall_template` 再 smoke（smoke 对已有动态包的模板测到的是动态版本，builtinOrder 机制无法直测内置）。
11. **@results 表达式两处硬修复**（额外发现）：
    - **语法错误**：`collect` 收尾 `break;}}` 多关一层，`return`/`const start` 被挤出函数体——`searchResultsExpr`/`googleResultsExpr` 生成的页面代码**从未在 V8 下合法过**；9-04 的 smoke passed 是因为 Windows 上 dist 为旧构建。已修复 + 新增 core 语法守卫（esbuild 转译真实生成函数 → new Function 解析）。
    - **Google UI 链接过滤**：内置 googleResultsExpr 内置排除表；通用 searchResultsExpr 新增模板声明式 `excludeUrlPrefixes`（search 动态包已声明）。不做全局内置——finance 需要抓 `/finance/quote` 前缀。
12. **bing-search flaky 根因修复**：`waitForURL` 通过时新文档 body 尚未创建，`pickRoot()` 返回 null → `querySelectorAll` TypeError（不在瞬态重试名单）→ 首跑失败。修复：pickRoot 兜底 `documentElement` + collect 调用包 try/catch 交给既有重试循环。修复后 4 连 smoke 通过。
13. **export_guide 平台兜底**：user-data-dir/chromeExe 占位值按平台显示（此前恒为 Windows 路径）。

## 门禁状态（2026-09-05 全绿）

`doctor`、`typecheck`、`test:core`（12/12，含新增 4 项）、`test:host`、`test:profile`（6/6）、`registry:build` + `registry:check`。`dist/` 已重建并 reload 到运行中的扩展。

## B站适配（2026-09-05 追加）

- `bilibili-search`（第 9 个站点）+ `bilibili-download-video`（媒体下载能力）已登记进 site-regression-plan（10 个产品工作流）。
- 下载方案：页面上下文 fetch B站 playurl（`platform=html5&high_quality=1`，登录态共享）→ 单文件 MP4（音视频合成）→ 页面内 blob 锚点另存到 ~/Downloads。无需新权限、无 Referer 问题（页面发起）。
- 已知限制：清晰度实测 360P~720P 浮动（短时高频请求被B站降档，等待恢复）；1080P+ 为 DASH 分离流需 ffmpeg 合成，明确不做；番剧/互动视频/充电专属返回结构化错误；>2GB 拒绝。
- 1080P 的未来路径（如需要）：扩展加 declarativeNetRequest 权限改写下载请求 Referer + DASH 双文件下载（音/视频分开，不合成）——待产品决策。

## 财经资讯站适配（2026-09-05 第二批）

- 雪球/股吧/韭研公社各含 search + article 两个模板，共 6 个（产品工作流已达 16 个）。全部真机 smoke passed。
- **反爬边界（宪章红线）**：只做真实浏览器+共享登录态+低频单页抓取；不做验证码绕过/指纹伪装。站点风控触发时记 blocked。
- 站点关键事实：雪球搜索 /k?q=（SPA，需登录）；股吧帖子搜索必须走 so.eastmoney.com/tiezi/s（/guba/s 会重定向首页），正文 #newscontent；韭研公社搜索路径 token 为站内固定值（/search/fa3409...?k=词），需微信登录。

## 截图验证与互动/排序升级（2026-09-05 第三批）

- **截图比对**：雪球搜索/雪球文章/股吧搜索/九阳搜索 4 张截图与提取文本逐字一致（发现并确认了截图里可见的互动数字与排序控件）。
- **互动数据 v1.1**：雪球搜索每帖带 reposts/replies/likes（.timeline__item__control 顺序=转发/评论/赞，与截图数字交叉验证一致）；雪球文章 engagement 走 statuses/show.json 接口（likes74/replies106/retweets14 与截图一致）+ author/pubTime；股吧帖子带 postTime/replies（页面正则，尽力而为）；九阳文章 engagement 尽力而为（badge-box，取不到为 null）。
- **排序 v1.1**：雪球 sort=latest（点「最新讨论」）、股吧 sort=latest（点「按时间排序」，带 6 次重试）、九阳 sort=latest（点「按时间」）——三个搜索 smoke 全部以 time 排序通过。
- **九阳互动的诚实结论**：搜索结果页互动条仅个别卡片渲染（按热度/按时间视图均不稳定），站点不提供稳定来源——搜索模板不返回互动字段（v1.2.0），文章模板取不到时返回 null 而非 0，README 均已说明。
- 九阳搜索 v1.2.0 曾引入表达式语法残留（字符串手术事故），已修复并保留语法守卫流程（new Function 预检）。

## 评论/列表能力补全（2026-09-07）

- `xueqiu-comments` v1.0.0：statuses/comments.json 接口分页评论（user/text/likes/time），smoke passed。**至此雪球完整链条成立：搜索→帖子全文→评论翻页。**
- `jiuyangongshe-comments` v1.0.0：.comment-content 懒加载抓取（滚动全页触发），smoke passed。
- `guba-list` v1.0.1：个股吧列表页（.listitem）——标题/链接/阅读数/评论数/时间，默认按时间，smoke passed。**列表级互动数据以本模板为准。**
- **股吧帖子回复区仍受限**：新改版回复列表为 gbapi 懒加载，页面外 fetch 被 CORS 拦截、页面内点击展开才渲染且结构不稳定——回复内容暂不可爬（guba-article README 已声明），后续如需要可走点击展开方案。
- 教训记录：write_pkg 时 example/smoke 传参顺序写反导致断言错位（smoke 契约 minLinks 打在没有 links 字段的模板上）；js 表达式内自导航与 evalPage 瞬态重试互相踩（Inspected target navigated）——导航一律用 open_tab 步骤，js 只抓取。

## 账号订阅/大V时间线（2026-09-07 第二批）

- `x-user-timeline` v1.0.0：X 账号主页推文流（text/time/url，滚动加载可加深，登录墙返回结构化 login_required）。mac 真机验证：X 可达且该 profile 已登录 X，elonmusk 时间线 4 条推文提取成功。选择器复用 x-search 体系。
- `xueqiu-user-timeline` v1.0.0：雪球用户主页时间线（xueqiu.com/<数字uid>），摘要+转发/评论/赞+帖子链接。
- `jiuyangongshe-user-timeline` v1.0.0：作者主页 /u/<hash> 文章流（滚动触发懒加载）。
- 组合链路：user-timeline → article → comments 已在三家全部成立（大V订阅完整链路）。
- **股吧作者订阅待做**：财富号文章页只暴露通用 i.eastmoney.com「个人主页」入口，无稳定作者 uid URL；财富号作者页真实 URL 形态（caifuhao.eastmoney.com/dh/<id>?）待后续确认。
- 教训再次复现：write_pkg 的 example/smoke 传参顺序写反（第二次了）——模板包脚手架应改为具名参数或写个单测锁死顺序。

## 下一步优先级

1. 其余动态站点在 mac 真机复测一轮（`npm run smoke:template -- baidu-search x-search google-finance-search`；chatgpt-ask 需登录态）。Scholar/Gemini 保持 blocked，不得绕过。
2. 若要回归扩展内置兜底版本：先 `uninstall_template` 对应动态包，再 `npm run smoke:template -- <id>`（见 QUALITY-GATES 说明），测完重装动态包。
3. 完整回归 `npm run agents:regression`（opencode 外部 Agent 串行队列）——需要时再派发。
4. Review 遗留低优先级：事件缓冲跨重启的游标协议（generation 已提供基础）、第三方模板安装的 UI 风险提示。

## 已知风险

- mac wrapper 内嵌 homebrew node 绝对路径；node 升级/迁移后重跑 `npm run register-host:mac`。
- Google（mac 区域）结果链接为 `/goto?url=` 跳转形态；如需最终 URL 可在消费端解析或后续增强 normalize。
- `set_humanize` 仍未实现；单 Chrome profile 共享 cookie、可见操作串行。
- 模板 `expect` 子串匹配仍对存量动态包生效（bing/baidu/x/finance 等包内 `expect:"true"` 未逐个升级为 expectations，行为兼容、精度弱）。
- 仓库无 git：无法追溯"表达式语法何时引入"；建议尽早 `git init` 建立基线（需用户授权）。

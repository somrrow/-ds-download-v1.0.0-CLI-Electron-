# QQ Agent 插件：视频下载（肥鱼当劳）

把「肥鱼当劳（ds-download）」接到 [QQ Agent](https://github.com/Kondius/qq-agent) 上：
**群里出现视频/图文链接 → 自动下载 → 把视频（或图文图片）发回当前会话**。

## 工具是**内置**的，不依赖任何外部目录

插件自带整个工具（`plugins/video-downloader/tool/`，约 **420 MB**）：

| 内容 | 大小 | 说明 |
| --- | --- | --- |
| `src/cli.js` + `src/core/**` | 0.4 MB | 命令行 + 下载引擎 |
| `src/gui/main.js` + `preload.js` | — | **无界面**的浏览器助手（抖音这类要渲染的站点用它，不开窗口） |
| `tools/yt-dlp.exe` / `ffmpeg.exe` | 96 MB | 站点解析与音视频合并 |
| `electron/` | 324 MB | **渲染引擎**：未打包的 Electron 运行时，浏览器兜底靠它（打包版 exe 不认 app 目录，QQ Agent 自己的 exe 用不了） |

跑起来用 QQ Agent 自己的 Electron 当 Node（`ELECTRON_RUN_AS_NODE=1` + `src/cli.js`），
所以机器上**不用装 Node**，也不用留着 `D:\视频下载工具` 这个源码工程：

- 设置里的「外部工具目录」**留空即可**（填了才走外部那份）；
- 渲染引擎优先用内置的 `tool/electron/electron.exe`，日志里会写
  `渲染引擎（抖音等需要渲染的站点用）：…\tool\electron\electron.exe`；
- 登录 Cookie 是**可选**复用：不配也能下免登录的内容（配了才能下 B站专栏/会员清晰度）：
  `data/video-downloader/login-cookies.txt`（想单独给机器人一份就放这儿）→
  `%APPDATA%\ds-download\tools\login-cookies.txt` → 源码工程那份（最后兜底）。

内置/更新：

```cmd
node qqagent-plugin\bundle-tool.mjs --with-electron   :: 全套内置（源码 + yt-dlp/ffmpeg + 渲染引擎）
node qqagent-plugin\bundle-tool.mjs                   :: 不带渲染引擎（抖音那类站点会需要外部 Electron）
node qqagent-plugin\bundle-tool.mjs --no-tools        :: 连 yt-dlp/ffmpeg 也不带（首次用时自己下载）
qqagent-plugin\deploy.cmd                             :: 部署插件时顺带跑一次（--skip-existing，大文件不重复搬）
```

内置进去的东西（脚本会**逐项校验**，多了就报错退出）：上面那张表里的四类 +
`package.json`（去掉 `devDependencies`）+ 简短 `README.txt`。
**明确排除** `src/gui/renderer/`（真正的界面：HTML/CSS/JS + logo）、`build/`、`dist/`、`tests/`、
`*.ico/*.png`（图标）、以及 `history.json`/`login-cookies.txt`（本机用户数据）。

> 磁盘占用提醒：整套内置后插件目录约 420 MB（其中 324 MB 是渲染引擎）。只想要最省的版本就
> 不带 `--with-electron`（约 96 MB），代价是"需要渲染的站点"（抖音等）得另找一份 Electron。

数据落地（都不在插件目录里，升级不会丢）：设置/历史/Cookie 在 `data/video-downloader/`，
yt-dlp/ffmpeg 就是包里 `tool/tools/` 那份（原地用，不重复复制）。

这里是**源码备份**。已部署的运行副本在：

```
D:\qqagent\QQ Agent\resources\app\
  ├─ plugins\video-downloader\
  │    ├─ plugin.json          清单（设置项、配置界面、提示词片段）
  │    ├─ index.js             实现（media.download + pixiv_search 工具 + onIncoming 钩子）
  │    ├─ card-links.mjs       QQ 分享卡片 → 链接的转译模块（给核心补丁 import）
  │    ├─ search-command.mjs   「我要 xxx 的图」句式识别（钩子每来一条消息就问它一次）
  │    └─ tool\                **内置的工具**（基础版：cli.js + core/** + yt-dlp/ffmpeg，无界面无图标）
  ├─ src\onebot.js             核心（被 card-links 补丁改了 3 行）
  └─ src\app.js                核心（**原样未改** —— 确定性搜图指令走运行时钩子，不需要补丁）
```

## 为什么做成「插件」而不是「技能」

QQ Agent 把扩展分两型，判据是**"什么时候该运行"**：

| | 放哪 | 谁决定何时执行 |
|---|---|---|
| 插件（确定性型） | `plugins/<id>/` | **核心代码**：满足条件必然执行，不经过 LLM |
| 技能（LLM 型） | `skills/<id>/` | **模型**：看工具说明自己判断 |

关键证据在核心源码 `src/media-links.js`：它**已经**从消息里抽候选链接，逐个问所有
`media.download` 提供者「谁认领谁处理」，整条链路没有任何"让模型决定"的环节 ——
这就是插件形态。**规则能写死 → 插件**。

反过来，如果把只提供 `providers` 的模块放进 `skills/`，`plugin-loader.js` 的
`lintKindPlacement()` 会警告"模型看不到它，功能永远不会被触发"——功能静默失效。

## 契约（照抄 `src/media-links.js`，否则会静默不生效）

```js
provider({ url, onebot, sender, kind, chatId, text })
  不认领      → { skip: true }                        // 让给下一个提供者
  认领并成功  → { ok: true, platform, title }         // 消息自己已经发出去了
  认领但失败  → { ok: false, error, friendly? }        // friendly 会被核心发到群里
```

发送**必须**走 `ctx.sender`（`sendMedia` / `sendImage` / `sendTextBatch`），
不能自己调 onebot —— 否则会绕过限频与留档。

## 发送的段格式（已对着 SnowLuma 源码验过）

- 视频：`[{ type: 'video', data: { file: 'file:///D:/.../x.mp4' } }]`
  SnowLuma 的 `pickMediaSource()` 明确接受 `file://`，`stageSourceToDisk()` 用
  `fileURLToPath()` 解出来自己读盘上传；视频段必须是**整条消息里唯一的段**（QQ 的限制）。
- 群文件：`[{ type: 'file', data: { file: <同上的 URI>, name: 'x.mp4' } }]`
- 图片：`[{ type: 'image', data: { file: <同上> } }, ...]`（一次多图用 `sendMedia`）

## 怎么调下载

插件不改这个工具的代码，而是**spawn 它的命令行**（`src/cli.js --json`）：
`process.execPath` + `ELECTRON_RUN_AS_NODE=1`（QQ Agent 是 Electron 应用，机器上不一定有
独立 node.exe）。这样工具自己的全部能力原样可用：yt-dlp / ffmpeg 自动获取、
抖音的内置浏览器兜底、图文帖轮播翻页、B 站专栏只取正文图、登录 Cookie、
代理自动跟随系统代理、直播录制……

## 「我要 xxx 的图」：固定句式直接搜图，**0 token**

平常搜图是模型调用 `pixiv_search` 工具 —— 为了听懂一句「来张初音ミク的图」，得先把
整个上下文（提示词 + 历史 + 工具定义）发过去，**一轮就是一次完整计费**。
这些句式是完全固定的，根本不需要模型参与，所以做成了**确定性触发**：

| 句式（xxx = 关键词） | 例 |
| --- | --- |
| 我要xxx的图 / 我要看xxx的图 / 我想看xxx的图 | 我要看初音ミク的图 |
| 来点xxx的图 / 来张xxx的图 / 来3张xxx的图 / 来几张xxx的图 | 来3张猫娘的图 |
| 有没有xxx的图 / 有xxx的图吗 / 求xxx的图 / 搜点xxx的图 | 有没有猫娘的图 |
| 再给我来点 / 再来一张 / 再来几张 | 再来一张topu的图 |
| 给我几张 / 给点 / 给一个 / 送我几张 / 发点 | 给点蔚蓝档案的图 |
| 找与xxx相关的图片（会剥掉「与…相关」这层壳） | 找与pid120514666相关的图片 |

命中之后：**直接搜图下载，模型这一轮根本不会启动**（0 token）。

### 怎么做到的：挂在 `Orchestrator.onIncoming` 上

`orchestrator.onIncoming` 是**每条**入站消息（已过白名单/屏蔽名单）的必经点。
本项目里已有两个插件走同一条路（`punch-card` 的打卡测试指令、`netease-voice-song` 的点歌），
约定是：前置钩子返回 `'veto'` → **不调用原方法** → 不排会话、不叫醒模型。本插件照抄这个约定：

```
消息入库 → onIncoming → [本插件钩子] 命中 → 先标已读 → 后台搜图 → veto（原方法不执行）
                                        ↘ 不命中 → 原方法照常（行为与从前完全一致）
```

好处：**不用改核心文件、不用重启**（插件是热重载的），应用升级也不会冲掉它。
（备用的 `message.image-request` 能力 + 核心补丁那条路还留着，只有钩子挂不上时才用得上；
两条路不会重复执行 —— 钩子在位时能力提供者一律不认领。核心现在**没有**被改动。）

> ⚠️ **必须"先标已读、再 veto"**，而且标已读失败时**不能** veto：标不上还 veto 的话，
> 这条消息会一直挂着未读，兜底定时器迟早还是把模型叫起来 —— 白省 token，还多下一次图。
> 这个坑真的踩过：`store.markEntryRead` 是 **(chatKey, id) 两个参数**，只传 id 不报错、静默失效，
> 结果那一轮照样烧了 6.7 万 prompt token（表现就是"补丁看着生效了、token 却没省下"）。
> `verify.mjs --cmd` 里现在有两条对应的行为测试（单/双参数语义、veto 与不 veto）。

> ⚠️ **`dispose` 绝不摘壳**。`onIncoming` 是多个插件共用的链表，热重载时新旧实例的
> install / dispose 会交错（同一秒里能连挂两次），旧实例 dispose 读到的是**新实例刚写下
> 的记录**，于是把新实例的壳当成自己的还原掉 —— 链上只剩原方法，表现就是"指令发出去
> 完全没反应、日志里一个字都没有"。所以现在：壳留着（没有实现就把消息原样交回下游）+
> 探针自检（`chainReachesUs`）+ 30 秒看门狗自动重挂。详见文末「已踩过的坑」。

### 刻意的"宁可漏、不可错"

群里正常聊天被当成搜图指令、还静默下载一堆东西，比"漏给模型"糟糕得多。所以：

- **必须命中开头那个触发词**：`刚刚那张图`、`这张图的链接发我` 一律不认领；
- 末尾必须是「图/图片」：`我要这张图的出处` 不认领；`再来2张`（没说图）也不认领；
- 关键词里不许出现「什么/哪张/这张/那张」：`有没有什么好看的图` 不认领；
- 整句长度上限（默认 40 字，可设）：长句里的"我要…的图"多半是真在说话；
- 整句其实是别的意思时先排除：`发现这张图拍得不错` 不会被拆成触发词「发」；
- **@ 了别人**（不是机器人）不认领 —— 那是在跟别的群友说话；
- 没命中的消息**一切照旧**：走模型，模型想调 `pixiv_search` 就调（工具那条路没动过）。

### 自检

```bash
node qqagent-plugin/verify.mjs --cmd        # 脱网：识别用例 + 钩子 veto 行为 + 备用路径端到端
node qqagent-plugin/verify.mjs --cmd-live   # 真实联网：走生产路径真搜一次，确认一条消息都没发
node qqagent-plugin/image-request/apply.mjs --check   # 只报告那条可选的核心补丁状态
```

> 命中之后**发不发图**由「搜图结果怎么处理」决定（默认 `download` = 只下载、群里一个字都不发；
> 设成 `images` 就是只发图不发字）。开关：设置里的「确定性搜图指令（0 token）」；
> 「允许搜图（Pixiv）」关掉时它也一起失效。

### 那段可选的核心补丁（现在不需要）

`image-request/apply.mjs` 会给 `src/app.js` 的 `ingestMessage()` 插一句"问插件"（能力
`message.image-request`），配合插件里的同名提供者实现同样的效果 —— 只作为**钩子挂不上时的备用**。
平时不用跑；真要跑：`node qqagent-plugin/image-request/apply.mjs`（`--check` 看状态、`--revert` 还原、
改核心后要重启 QQ Agent）。核心当前是**原样未改**的状态。

## QQ 分享卡片 → 链接（要顺手给核心打 3 行补丁）

群友在群里发**视频分享卡片**（B站/抖音/公众号的 json 卡片、xml 卡片、OneBot `share` 段）时，
QQ Agent 原来只把它变成 `[卡片消息]` —— 卡片里的 URL **根本没进消息文本**，而链接转发
（`src/media-links.js`）只从文本里抽链接，于是卡片永远走不到 `media.download`，白白错过。

转译后长这样：

```
[卡片消息] 【新宿决战】五条悟猫VS宿傩猫 https://b23.tv/AvOCzlr
```

`[卡片消息]` 保留（模型和旧提示词都认得），后面补上标题 + 链接 → 链接转发能认领、模型也看得见。

**为什么必须动核心**：插件的扩展点里**没有"消息进入"这一环** —— 能力表里只有
`media.transcribe`（只拿语音）和 `message.inline-at-normalize`（只处理 @ 段）；`runHook()` 核心一处都没调用；
工具是"模型按需调用"，做不到"自动"。所以拆成两半：

| 文件 | 放哪 | 作用 | 应用升级会覆盖吗 |
| --- | --- | --- | --- |
| `card-links/card-links.mjs` | 插件目录 | 全部解析逻辑（json/xml/share，含小程序壳地址过滤） | 不会（在 plugin 目录里） |
| 核心补丁 | `src/onebot.js` | 只加 3 行：`case 'json'/'xml'/'share'` → 调插件模块 | **会**（升级后重打） |

```bash
node qqagent-plugin/card-links/apply.mjs           # 打补丁（自动备份 + 自动校验，失败自动还原）
node qqagent-plugin/card-links/apply.mjs --check   # 只看状态
node qqagent-plugin/card-links/apply.mjs --revert  # 从备份还原
node qqagent-plugin/verify.mjs --cards            # 转译 + 部署副本 + 核心补丁 端到端回归
```

> ⚠️ 改的是**核心文件**：打完要**重启 QQ Agent**（插件是热重载的，核心不是）。
> 升级 QQ Agent 会覆盖 `resources/app` → 卡片又只剩 `[卡片消息]`；重跑一次 `apply.mjs` 即可。
> 模块缺失/报错时补丁会退回原来的占位符，**不会因此把核心搞崩**。

### 另一个核心补丁：短链剥查询串（可选，防"同一视频发两次"）

`media-links-shortlink/apply.mjs` 给 `src/media-links.js` 的 `extractCandidateUrls` 加一行归一化：
**短链域名（`b23.tv` / `v.douyin.com` / `v.kuaishou.com` / `t.cn`…）的查询串整段丢掉**。

原因：那个函数里有两条正则（一条收带协议的完整链接、一条兜裸短链），同一条卡片消息
`[卡片消息] 哔哩哔哩 https://b23.tv/X?share_medium=…&ts=…` 会被抽出**两个 URL**，
派发两次 → 插件各下一次、各发一遍。剥掉查询串后只抽出一个。

```bash
node qqagent-plugin/media-links-shortlink/apply.mjs           # 打补丁（自动备份 + 自检，失败自动还原）
node qqagent-plugin/media-links-shortlink/apply.mjs --check   # 只看状态 + 跑三条行为断言
node qqagent-plugin/media-links-shortlink/apply.mjs --revert  # 从备份还原
```

> 这个补丁**不是必须的**：插件端 `canonicalUrlKey()` 已在去重键上做了同样的归一化，
> 不打补丁功能也正常，只是会多派发一次（多一次下载）。打了要**重启 QQ Agent** 才生效；
> 升级核心后同样会丢，重跑一次即可。

### 第三个核心补丁：GIF 动图抽成多张静态帧（给"只能看静态图"的模型）

`gif-frames/apply.mjs` 新增 `src/gif-frames.js`，并给 `src/tools.js` 打三处改动：
GIF 到模型面前时**先在本地抽成 6~12 张静态帧**，以多张 `image_url` 发出去。

为什么（2026-10-18 现场，用户模型是 deepseek v4.1 flash，**只能看静态图**）：

| `api.video` | 核心原行为 | 后果 |
| --- | --- | --- |
| `true` | GIF → mp4 → `video_url` | DeepSeek 接口 **422**（unknown variant `video_url`），整轮失败 |
| `false` | GIF 原样当 `image_url` 发 | 模型只解得到**第一帧**，回答"这张不动" |

两条路都拿不到动作。补丁加了第三条：`downloadImageAsDataUrl()` 里 GIF 先调
`gifFramesDataUrls(buffer)`（帧数按时长 ≈4 帧/秒、夹 6~12），成功就返回 `{ frames:[…] }`，
`getImagePartsOrVideo()` 再逐张 push `image_url` —— 不依赖模型支持视频，也不用改任何设置。
读图主路径（`image-ref-hint` 的缓存命中）本来就会抽帧，这个补丁把**表情包 / 缓存未命中 /
内置 `read_image`** 这几条也覆盖了。

```bash
node qqagent-plugin/gif-frames/apply.mjs           # 打补丁（备份 + 自检：真抽一次帧）
node qqagent-plugin/gif-frames/apply.mjs --check   # 只看状态 + 跑抽帧自检
node qqagent-plugin/gif-frames/apply.mjs --revert  # 还原（删新文件 + 恢复 tools.js）
```

> 要**重启 QQ Agent** 才生效（核心文件）。不打也不会崩：GIF 仍按原样发，只是模型看到第一帧。
> 自检样例：3.1 秒的动图 → **12 帧**；0.1MB 小图 → 12 帧。

## 搜图命令收到之后：只下载 / 只发图 / 图+两句固定话

搜图那条链路（模型调用 `pixiv_search` 工具 + 「我要 xxx 的图」这类固定句式）和"有人贴链接"
那条链路（`media.download`）**分开控制**。搜图用完的产物怎么处理由 `searchSendMode` 决定：

| 取值 | 行为 | 什么时候用 |
| --- | --- | --- |
| `download`（默认） | **只下载**：图留在本机，群里一个字都不发（图也不发）；下载情况写进控制台日志 + 工具返回值，并明确要求模型**不要发言** | 只想把图收下来、不想让机器人说话的场合（静默收集） |
| `images` | **只发图**：图（超出上限照旧打包成 zip 当群文件）发到会话，但不发任何文字 | 想让群友看到图、又不想多话 |
| `send` | **图 + 三句话**：收到指令先发「**开始搜图了：<关键词>**」，图下好后、发图**之前**发「**图片正在发送：<关键词>（N 张）**」，图发完再补一句来源说明（见下） | 想让人一眼看出"在搜了 / 图马上来 / 走的是哪条搜索路" |

实现上的三个要点：

- `send` 的两句提示语在 `performSearchRequest` 里发：**开始那句在下载之前**（收到指令就吱一声）、
  **「图片正在发送」在图片之前发**（2026-10-19 用户要求：它是"图马上来"的预告；搜图失败就不发这句，免得群里以为有图）；**两句都带关键词**（`开始搜图了：高松灯` / `图片正在发送：高松灯（2 张）`）—— 核心发送管道有 8 秒文本去重，完全相同的两句话会被静默吃掉；
  发提示语失败只记日志，绝不影响搜图本身；
- 这两句**由插件自己直接发**（走核心的 `sender.sendTextBatch`：限频 / 去重 / 留档都在里面），
  **不经过模型**：固定句式那条路上模型压根不会被叫醒（钩子 veto），
  模型即使在别的路径调了搜图工具，返回值里也会明确要求它别复述这两句；
- 工具返回值里带着**这次的模式**与"要不要说话"的明确交代（`download` 模式下会写
  "不要调用任何发送/回复类工具"）—— 模型不必猜，也不会被老提示词带偏；
- `deliver({ quiet: true })` 只压制**说明文字**，媒体照发，返回的字符串照旧带情况（进日志与返回值）。

```bash
node qqagent-plugin/verify.mjs --search   # 脱网确定性：三种模式的计划（含两句提示语）+ quiet 压文字
node qqagent-plugin/verify.mjs --cmd      # 里面还有一条 send 模式端到端：开始搜图了 → 图片正在发送 → 图
node qqagent-plugin/verify.mjs --search-live   # 真实联网跑一遍（MODE=download|images|send，KW=关键词）
```

> 检索接口里混着**已被作者删除/限制访问**的作品，它们在反代上是 404。实测第一次就撞上了：
> `count=1` 时那一个候选恰好 404，整次搜图就变成"没搜到可用的图"。所以现在**按 `count + 备胎`
> 取候选，凑够 `count` 个下成功的才停**（失败的仍记一条结果，日志里说明跳过了谁）——
> `tests/run.js` 里有对应的回归用例（关键词含「补足」时模拟一个 404 候选）。

## 部署 / 更新

```cmd
qqagent-plugin\deploy.cmd
```

或手动把 `video-downloader\` 整个目录复制到
`D:\qqagent\QQ Agent\resources\app\plugins\` 下。**QQ Agent 开着热重载，落盘即生效**，
不用重启；控制台的「插件」页签里能看到它。

> ⚠️ QQ Agent 升级会覆盖 `resources/app`，插件会被清掉 —— 升级后重跑一次 `deploy.cmd`。

## Pixiv 不需要代理（研究「Pixiv 来张图」插件后的成果）

`pixiv.net` 在大陆直连不通，本工具原来靠"内置浏览器 + 系统代理"去请求官方 ajax 接口 ——
**用户没配代理时必然失败**（`www.pixiv.net:443 Connect Timeout`）。参照 QQ Agent 里那个
「Pixiv 来张图（自建）」插件的做法，加了一条完全不需要代理的通道：

| 用途 | 服务 | 实测 |
| --- | --- | --- |
| 搜图 | `api.lolicon.app/setu/v2`（按标签/关键词检索） | 大陆直连 HTTP 200；返回 `urls.original`（i.pixiv.re 完整原图路径） |
| 取图 | `pixiv.re` 反代 | `https://pixiv.re/<pid>.png` = 第 1 页、`-2.png` = 第 2 页…**第 N+1 页 404 就是到底了**；字节数与官方原图完全一致；**不需要 Referer** |

关键实测（pid 150727863，5 页作品，用走代理的官方 pximg 下过一遍做字节对照）：

```
200  535736B  https://pixiv.re/150727863.png      ← 第 1 页（= 官方 001，535,736 B）
200  558307B  https://pixiv.re/150727863-2.png    ← 第 2 页
200  421910B  https://pixiv.re/150727863-3.png    ← 第 3 页
200  356021B  https://pixiv.re/150727863-5.png    ← 第 5 页
404           https://pixiv.re/150727863-6.png    ← 只有 5 页 → 逐页探测的终止条件
404           https://i.pixiv.re/150727863.png    ← 这个域名只认带日期的完整路径（别用简写）
```

工具侧落地：

- **作品链接**：先试官方接口，失败**自动**换反代（日志会写「官方接口取图失败…改用反代（不需要代理）」），
  多图作品会把**每一页**都补齐（官方那条路给不出页数时靠逐页探测）。
- **搜图命令**：`vgrab --pixiv-search "初音ミク" --count 2`（`--list-only` 只列不下载、`--r18` 允许成人向、
  `--pixiv-source api|mirror|auto` 强制取图来源）。每个作品下到自己的子目录 `<标题> by <作者>`。
- **插件侧**：注册了 **`pixiv_search` 工具**，群友说「来张初音ミク的图」时模型可以直接搜图并下载；
  默认只出全年龄（按作品标签二次筛 R-18 / R-18G），成人向需要在设置里显式打开。
- **搜到之后怎么办**由 `searchSendMode` 决定（默认 **只下载，群里不发任何消息**，见下节）。

### 代理开着的时候：公开接口/反代**直连**，原生搜索才走代理（2026-10-19）

配了代理≠所有请求都该走代理。实测过两次"代理一开、搜图就废"：

| 请求 | 走不走代理 | 为什么 |
| --- | --- | --- |
| 公开检索接口 pi.lolicon.app | **直连** | 大陆直连 HTTP 200；走代理只会更慢，代理挂掉还会被误判成"接口抽风" |
| pixiv 反代 pixiv.re / i.pixiv.re | **直连** | 反代本身就在国内可达；走代理反而多一跳 |
| pixiv **原生**接口 www.pixiv.net | **走代理** | 大陆直连不通，这是唯一必须代理的一步 |
| 官方图床 i.pximg.net | **走代理** | 同上，且需要 Referer |

实现：src/core/http.js 新增 directFetch（显式无视 setHttpProxy 注入的全局实现），
pixiv.js 在每个请求上用 etch: directFetch 声明"直连"；图片下载按 URL 主机**逐张**决定
（isPixivOfficialHost() → 官方图床留空走代理，其余直连）。
验证：把代理配成 http://127.0.0.1:9（死端口）后，--pixiv-search 仍能搜到并下载成功，
而原生搜索会以 ECONNREFUSED 明确失败 —— 说明两条路确实分开了。

> ⚠️ 与「Pixiv 来张图（自建）」插件功能重叠：两个都开着时模型会看到两个搜图工具。
> 建议只留一个 —— 那个插件有按会话的 R18 分级（带主人身份校验）；本插件胜在**不需要代理**、
> **多图作品会把每一页都补齐**、图多时自动打包成压缩包。

### 踩过的坑

- **`-n` 不是数量**：本工具里 `-n` 早就是 `--name`（输出文件名），写成 `-n 2` 会让所有图叫 `2.png`；
  数量必须用 `--count`。
- **图片帖判定必须在预探测之前**：pixiv 链接的判定根本不需要访问 pixiv.net，而预探测（请求作品页）
  在没代理时会先超时失败，任务就此结束 —— 免代理那条路**根本没机会跑**。所以下载流程里
  把"是不是图片帖"提到预探测之前了（`src/core/downloader.js`）。

## 登录态：直接用 Microsoft Edge 的 cookie（不用再单独导出文件）

B 站会员清晰度、需要登录的站点要带 cookie。以前登录态只有两条路：插件自己的
`login-cookies.txt`，或桌面版「在内置浏览器里登录后导出」的那份 —— 可大家平时是在
**Edge 里**登录 B 站的，浏览器里有 cookie，机器人却等于没登录。

现在插件会自己去 Edge 里读：`edge-cookies.mjs`

- 库文件：`%LOCALAPPDATA%\Microsoft\Edge\User Data\<Profile>\Network\Cookies`（SQLite）
- 密钥：`Local State` 里的 `os_crypt.encrypted_key` → 去掉 `DPAPI` 前缀 → **DPAPI 解密**
  （走一次 PowerShell 的 `ProtectedData.Unprotect`，等价于"以当前用户身份解密"）
- 值：`v10` + nonce(12) + 密文 + tag(16) 的 **AES-256-GCM**；老格式退回 AES-256-CBC（IV=16 空格）
- 导出成 Netscape 文件 `data/video-downloader/edge-cookies.txt`，再用 `--cookies` 传给工具

三个现实约束（都处理了）：

1. **Edge 开着时读不出来**：Cookies 文件被独占（连只读都拒绝），所以导出会失败并**只记一行日志**，
   15 分钟内不再重试（别每次下载都撞锁刷屏）。想要登录态：完全退出 Edge（托盘也退），
   下次下载 / QQ Agent 下次启动时会自动导一次。
2. **v20 解不开**：Edge 127+ 有一部分 cookie 用 app-bound 加密（密钥绑在浏览器私钥上），
   外部进程在技术上做不到 —— 会**如实跳过并在日志里报条数**，不假装成功。
3. **会过期**：导出文件默认缓存 6 小时（`edgeCookiesTtlMin`），过期后下次下载自动重导。

设置项：`cookiesSource`（auto/edge/file/off，默认 auto）、`edgeProfile`（默认 auto）、
`edgeCookieHosts`（留空 = 内置平台列表，`*` = 全导）、`edgeCookiesTtlMin`（默认 360）。

自检：`node qqagent-plugin/verify.mjs --edge` —— 造一条 v10 cookie 验解密、验 v20 被跳过、
验 Netscape 格式与域名匹配，最后真读一次本机 Edge（读不到只报告，不判失败）。

## 图片帖怎么发（图文 / Pixiv / B站专栏）

- 下载工具会把图文帖的图下到「以标题命名的子目录」，插件按下面的规则发出去。
- **图片默认先直接发 9 张**（防刷屏）；**多出来的全部打包成一个 zip 当群文件发**（一张都不丢），
  压缩包名取帖子标题，并发一行文字说明来由（免得群友不知道这个 zip 是什么）。
- `imageOverflow` 可切成 `all`（zip 里放**全部**图）或 `off`（只发前面几张，其余留本机）。
- **格式归一化**：B 站现在的图很多是 **avif**，而 QQ 图片消息基本只认 jpg/png/gif/bmp/webp
  （协议端的 `detectImageFormat` 压根没有 avif 分支），直接发很可能失败。所以
  `convertImages=risky`（默认）会用工具自带的 `tools/ffmpeg.exe` 把 avif/heic/tiff/ico 转成 jpg 再发；
  `all` = 连 webp/png 也转；`off` = 原样发。**动图 gif 永远不转**（转了只剩一帧）；
  压缩包里始终是**原图**（zip 与格式无关）。
- **图文帖的「动图」会下成 GIF**：抖音图文帖里的动图，在 `url_list` 里只是**静态首帧**
  （`~tplv-dy-aweme-images:q75.webp`），真正的动画在同一条目的
  `images[i].video.play_addr.url_list`（一段 2~3 秒的 mp4）。工具现在从页面里（带登录态）
  请求 `aweme/v1/web/aweme/detail/` 拿到结构化数据，把动图那段 mp4 下下来用 ffmpeg 转成 **GIF**
  （480px/10fps 起步，超过 2.5MB 就逐档降到 360/8、240/6 —— 动图不需要高清）。
  转不成 GIF 就保留 mp4，插件会当视频发出去，总之不会再"变成一张静止图"。
  静态图的**首帧**同时会被排除，不会同一张图既存 webp 又存 gif。
- **图文帖里混着视频也照发**：抖音的一条图文帖常常是"几张图 + 一段视频"。工具现在会
  把视频和配图下到**同一个目录**并把目录交上来，插件 `collectArtifacts(..., {recursive:true})`
  会往里走一层，`deliver()` 先发视频、再发图片（两样都不丢）。
  以前视频分支直接 `return`，配图永远发不出去。
- 压缩包用 Windows 自带的 `tar.exe` 打（Win10 1803+ 内置），失败自动换 PowerShell 的
  `Compress-Archive`（脚本走 `-EncodedCommand`，中文标题不会乱码）。

## 默认行为（都可在「插件」页签里改）

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| 认领哪些链接 | `known+direct` | 已知平台 + 像直链的地址（.mp4/.m3u8/.mp3…）；`all` = 任何链接都试 |
| 代理地址 | 空 | 空 = 跟随 Windows 系统代理；填了就给工具加 `--proxy`。⚠️ pixiv 只有**原生接口/官方图床**用它，公开检索接口和反代一律直连（见上文「代理开着的时候」） |
| 清晰度 | `best` | 透传 `-q`；群里转发建议 720/1080 |
| 图文帖最多发几张 | 9 | 超过的部分打包成压缩包 |
| 图片超出上限 | `rest` | `rest` = 剩下的打包 / `all` = 包里放全部 / `off` = 不打包 |
| 压缩包上限 | 200 MB | 超过就只回一行文字 + 本地路径 |
| 图片转 jpg 再发 | `risky` | 只转 QQ 不认的格式（avif 等） |
| 搜图结果怎么处理 | `download` | `download` = 只下载不发消息 / `images` = 只发图不发字 / `send` = 图 + 「开始搜图了：关键词」…「图片正在发送：关键词（N 张）」两句固定话 |
| 确定性搜图指令 | 开 | 开 = 「我要 xxx 的图」这类句式直接搜图、**0 token**（需要核心补丁）；关 = 这些句子也交给模型 |
| 搜图指令整句长度上限 | 40 | 超过就不认领（长句里的"我要…的图"多半是在说话） |
| 视频转文件阈值 | 100 MB | 超过就改发群文件，再失败回文字说明 |
| 同时下载数 | 1 | 串行更稳，也不容易触发站点风控 |
| 单次下载超时 | 300 秒 | 到点连子进程树一起结束（Windows `taskkill /T`） |
| 直播最长录制 | 60 秒 | 直播链接按 `--live --live-seconds` 录一段 |
| 产物保留天数 | 0（永久） | 长期跑建议设 7，否则视频会占满磁盘 |
| 保存目录 | `data/video-downloader/` | QQ Agent 数据目录下，按链接建子目录 |

## 自检（改代码前后都能跑）

```bash
node qqagent-plugin/check.mjs          # 清单 JSON + 入口 ESM + settings/configSchema 对齐
node qqagent-plugin/verify.mjs --zip   # 脱网确定性测试：15 张图 → 9 张直发 + 6 张打包
node qqagent-plugin/verify.mjs --cards # 脱网确定性测试：卡片转译 + 部署副本一致 + 核心补丁状态
node qqagent-plugin/verify.mjs --search # 脱网确定性测试：搜图只下载/只发图/图+说明 三种处理方式
node qqagent-plugin/verify.mjs --cmd   # 脱网确定性测试：句式识别 + 核心补丁 + 假 CLI 端到端（不发消息）
node qqagent-plugin/verify.mjs --queue # 脱网确定性测试：多条链接并发 / 热重载中不丢排队任务 / 链接去重
node qqagent-plugin/verify.mjs --edge  # 脱网 + 实机：Edge cookie 解密 / Netscape 格式 / 域名过滤
node qqagent-plugin/verify.mjs --live  # 真实网络：直播录制（到点收尾并发出可播放文件）
node qqagent-plugin/verify.mjs         # 真实网络：Pixiv / 抖音图文 / B站专栏 三条链路
```

`check.mjs` 是**部署前必跑**的：清单 JSON 少一个逗号、字符串里多一个英文引号，
QQ Agent 只会记一行 `❌ 清单解析失败`，插件**静默不生效** —— 我这次就踩了两次
（第一次漏逗号、第二次字符串里写了 ASCII 引号），所以把校验脚本固化下来了。

## 已踩过的坑（都已在代码里处理）

| 坑 | 现象 | 处理 |
| --- | --- | --- |
| —（新功能，2026-10-25）| 群友不想要 AI 画的图 | 参照 `pixiv-illust` 加了「排除 AI 生成的作品」（`pixivExcludeAI`，默认关）：内置接口走服务端 `excludeAI=true`，原生搜索按标签（`AI` / `AI生成` / `AIイラスト` / `Stable Diffusion` / `NovelAI`…）过滤；全被过滤时会提示「结果里 N 条都是 AI 作品」 |
| **下载下来的视频没有声音（小红书等）** | 用户报「桌面版小红书视频下载下来没有声音」；实测那条文件 5,021,869B，比正常版（5,394,682B）**正好少一条音轨**；`ffmpeg -i` 只有一个 hevc 视频流、没有 `Audio:` | 2026-10-23：① 格式选择器显式要求带音轨（`bv*+ba/b[acodec!=none]/b`，1080 档同理）；② 下完用 `mediaHasAudio()` 复检，**没有音轨就自动用「必须带音频」的选择器重下一次**（`b[acodec!=none]/bv*+ba/b`），并在日志里写明。同一条链接复测：5,394,682B、有音轨 ✔ |
| **搜图 360 秒超时、一张图都发不出来** | 群里等 6 分钟后只收到「搜图超时了」。复盘：`i.pixiv.re` 拿一个 4.5MB 图要 **184 秒**、下一个 PNG 拖到 **490 秒**；同一时刻 `i.pximg.net`（走代理 + Referer）735ms 就回 64KB。旧代码只认反代一条路，慢就一路干等 | 2026-10-22 改成**图床测速 + 多路兜底**：并行 Range 探 64KB 测每个图床的真实速度（`i.pixiv.re / i.pixiv.cat / i.pixiv.nl / i.pximg.net`）→ 小图（预计 <20 秒）最快的两条**抢跑**、谁先完成用谁；大图只走最快那条并给足截止（按大小/速度估算，30~180 秒）；全部慢到没法用（预计 >240 秒）就**立刻失败**并提示「图床太慢」。成功的图床记进 `%LOCALAPPDATA%\vgrab\image-host.txt`，下次优先 |
| —（新功能，2026-10-20）| ① 同一张图会被重复发；② 只能按标签搜，不能按 pid/uid/作者搜；③ 数量卡 20；④ 第三方接口不够就不补 | 已全部实现：**① 发过的作品不再发**（记 `sent-pixiv.json` 的 pid，90 天/2000 条，搜图时 `--exclude-pids` 直接排除，连下载都省）；**② 输入自动识别** `pixiv.net/artworks/<pid>` / 纯数字 pid / `pixiv.net/users/<uid>` / `uid:123` / `author:名字`（作者名需要登录 cookie，没登录会明确让你用 uid/主页链接）；**③ 数量没有硬上限**（天窗 500）；**④ 顺序补齐**：lolicon 简体 → lolicon 繁体 → 原生简体 → 原生繁体，每步累积、够了就停，不够就继续，`backend` 会显示成 `lolicon/tag（繁体「高松燈」）+pixiv-native` 这样 |
| —（新功能）| 群友不知道图是"第三方聚合接口"还是"Pixiv 官方搜索"搜出来的 | 2026-10-19 新增：图发完后自动补一句来源说明，三档文案 ——「ⓘ 这次走的是 Pixiv 官方搜索（第三方聚合接口没有这个标签）（关键词：X）」「ⓘ 这次走的是第三方聚合接口（lolicon，按标签/关键词搜）（关键词：X）」「ⓘ 这次直接用了上次的结果 —— 缓存（N 分钟前搜过）（关键词：X）」。设置项 `searchBackendNote`（默认开）可关；`download` 模式本来不发消息，所以不受影响 |
| **【根因】经代理的请求 body 永远读不完 → 全被误诊成"代理重置"** | 搜图经常报「原生搜索被代理重置了」，失败时单次 6–30 秒；同期：mihomo 自带探测 200、.NET `Invoke-WebRequest` 400–750ms 拿到 56KB、裸 socket 579ms 拿到 63KB，**只有我们这条路径读不完 body**。换节点、换模式（rule/global）、换网络（手机热点）都无效 | 2026-10-19 定位到 `proxy-fetch.js` 的 `toFetchResponse()`：同一个 Node 流被 **两个消费者**抢 —— `Readable.toWeb(res.stream)` 已经接管成 web 流，`arrayBuffer()`/`text()` 又去 `collect(res.stream)`，web 流先读走时 `collect` 的 `end` 永不触发 → 一直挂到超时。修法：body 只留一个消费者（`new Response(body).arrayBuffer()`）。修完实测 200 / ~600ms / 74KB，原生搜索端到端恢复正常 |
| **换节点也救不回来：mihomo 探测 200、我们的 CONNECT 却超时** | 节点自救把 `✈️Final` 切到探测 312ms 的节点，**重试仍是 `请求超时（8000ms）`**；同一时刻 `GET /proxies/<node>/delay`（mihomo 内部探测）对同一 URL 返回 200/218–444ms。global 模式与 rule 模式都试过，结果一样（排除"规则把 pixiv 路由错"） | 2026-10-19 结论：不是节点选择问题，是**经代理端口的 CONNECT 请求**被重置/挂起（Node 与 curl 都一样），因此节点自救**无法根治**、保持默认关；真正有效的是上面的「缓存 + 熔断」。若要进一步排查，可在别的网络（手机热点）跑一次 `--pixiv-search`，以区分"本机出口 IP 被 pixiv 限"还是"代理实现问题" |
| **节点对 pixiv 不友好 → 原生搜索 ECONNRESET** | 同一 URL、同一时刻 mihomo 自带探测 4 个节点全 200（218–444ms），但经代理端口的请求（Node/curl 都一样）被重置；而且组选择会自己变（19:40 香港02 → 21:13 日本01） | 2026-10-19 新增**节点自救**（默认关）：`src/core/clash.js` 通过 Clash Verge 的控制接口（命名管道 `external-controller-pipe` + secret）逐个 `delay` 探测候选节点，把代理组（默认 `✈️Final`）切到第一个能连 pixiv 的，然后**重试一次**原生搜索；当前节点探测通过就**不动**。开启方式：CLI `--pixiv-node-failover` 或插件设置「原生搜索失败时自动换节点」。⚠️ 它会改全局代理选择；**如果换完重试仍然失败，会自动切回原节点**（2026-10-19 实测：切到探测 312ms 的节点后重试仍超时 → 说明失败常常与节点无关，见下一行） |
| **原生搜索经常被代理重置（ECONNRESET）** | 群里反复看到「Pixiv 原生搜索被代理重置了（连了 3 次都断…）」，每次都白等 30 秒；实测失败是**成簇**的（13:37 / 15:10 / 16:44 / 16:49 / 16:50 / 17:13），同一时刻重试常常 200ms 内又成功 | 2026-10-19：① 搜索结果**落盘缓存 30 分钟**（`%LOCALAPPDATA%\vgrab\pixiv-search-cache.json`），同一个标签反复搜不再打 pixiv（第二次 0 秒，backend 显示「缓存（N 分钟前搜过）」）；② 原生搜索**熔断**：连续失败 2 次就停 5 分钟，期间直接给结论（2 秒返回，不再硬等 30 秒），成功一次自动清零；③ 自测注入 `fetchText` 时完全不碰磁盘，门禁不会被上一次的缓存/熔断污染 |
| **搜到了但图下不来（原生搜索结果只有 pid）** | 原生搜索命中 1 个作品，取图却报「图片反代上没有这个作品（150578777）」—— 因为反代**简写**（`pixiv.re/<pid>.png`）500/404，而原生搜索只给 pid + 一张缩略图 | 2026-10-19：从缩略图反推原图地址（`/c/250x250…/img-master/img/YYYY/…_p0_square1200.jpg` → `i.pixiv.re/img-original/img/YYYY/…_p0.png`，`originalUrlFromThumb()`），再按 **png→jpg→gif** 探扩展名（实测那件是 jpg，猜 png 必 404，`extVariants()`），最后用 `_p0→_p1…` 补齐多页。实测「烏啾」→ 2 张 4.1MB 全下来 |
| **图发了但群里看不到（命中 QQ 的 fast-upload）** | 搜图成功、日志 `已发送 2 张图片`、协议端 `send_group_msg` 返回 `status:ok` + message_id，群里**什么都没有**，也没有自身回显；协议端日志里能看到 `image fast-upload hit (server already had bytes)` | 2026-10-19 实测：pixiv 原图常**已经在 QQ 的 CDN 上**（别人传过同一张），协议端走 fast-upload 复用缓存 → QQ **静默丢弃整条消息**。对照实验：原图丢、本地重编码后正常、把重编码那张再发一遍又丢。修法：发送前给图片塞一段**不影响画面**的注释（JPEG 的 COM 段 / PNG 的 tEXt 块 / GIF 注释扩展）换一个新 md5，`uniqueImageForUpload()`；`verify.mjs --uniq` 做回归 |
| 简体关键词搜不到（「我要高松灯的图」） | 公开接口 tag/keyword **两条路都 0 条**，原生搜索再因代理不稳挂掉 → 群里看到"我没搜到" | 2026-10-19：pixiv 标签几乎都是**繁体/日文**写法，简体名在那边不存在。新增 `src/core/zh.js`（OpenCC 单字表 2712 组，简→繁单向）+ `searchPixiv` 自动**用繁体重试**：`高松灯` → `高松燈` 立刻出结果。失败文案还会带上 `｜当前代理：无/系统代理/…`，插件据此区分"没配代理"和"代理不通" |
| 代理开着，搜图却失败 | 公开接口（lolicon）和 pixiv 反代明明直连可达，配了代理后请求被塞进代理隧道 → 代理一抽风就整条链路失败；反过来 pixiv 原生接口又离不开代理 | 2026-10-19 起**按请求**决定：`http.js` 新增 `directFetch`；公开检索接口、`probeImage`、反代图片下载全部 `fetch: directFetch` 直连；pixiv 原生接口和 `i.pximg.net` 保持走代理（`isPixivOfficialHost()` 逐张判断）。验证方式：把代理配成死端口 `http://127.0.0.1:9`，搜图仍成功、原生搜索报 ECONNREFUSED |
| `ELECTRON_RUN_AS_NODE=1` 被继承 | 工具的内置浏览器兜底全部失效，报 `Cannot find module ...`（完全看不出是环境变量的问题） | 插件用 `ELECTRON_RUN_AS_NODE` 跑 CLI 是必须的，所以去**工具侧**修：拉起 Electron 辅助进程前把这个变量摘掉（`util.js` 的 `electronChildEnv()`） |
| 清单 JSON 里的中文引号 | 插件在页面上"加载失败"，或静默不生效 | 用 `check.mjs` 卡住；字符串里的引号一律用「」 |
| QQ 不认 avif | 图下下来了但发不出去 | 发送前 ffmpeg 转 jpg（压缩包里保留原图） |
| 一条消息里的链接被反复贴 | 同一份视频重复下载/重复发 | 10 分钟内的同一链接直接跳过 |
| **多结果时工具打印的是 JSON 数组** | 搜图"失败"但图片其实已经下好了（旧解析器只认单个对象：`lastIndexOf('\n{')` 在缩进的数组上找不到、退化成 `indexOf('{')` 截出残缺 JSON） | `parseToolJson` 改成"每一行以 `{`/`[` 开头的位置都当候选、从后往前试解析"，并且**解析失败时回退去看目录里有没有东西**（有就照常发出去）；`verify.mjs --parse` 做回归 |
| **batch 文件必须 CRLF + 纯 ASCII** | `deploy.cmd` 被改成 LF 结尾后，cmd.exe 逐行读错位，报 `'in' is not recognized` / `'. was unexpected at this time.` 这种莫名其妙的错 | `deploy.cmd` 写成 ASCII + CRLF（文件头也留了注释提醒），输出说明一律用英文 |
| **别用 PowerShell 改 UTF-8 源码** | 本机是 Windows PowerShell 5.1：`Get-Content -Raw` 按 GBK 解码、`Set-Content -Encoding utf8` 再写回 → 整个文件变成乱码（中文全毁、换行错位），`verify.mjs` 就这么报废过一份 | 这类文件一律用能保证 UTF-8 的编辑器/工具改；PowerShell 只用来跑命令与做纯 ASCII 的批处理（`deploy.cmd` 就是纯 ASCII，所以安全） |
| **核心方法的"静默失效"** | `store.markEntryRead(chatKey, id)` 只传 id：不报错、不抛异常，就是**没标上** —— 消息仍算未读，兜底定时器随后照样把模型叫起来（那一轮白烧 6.7 万 prompt token，看起来就是"功能没生效"） | 现在改成"先标已读、拿返回值判断"，标不上就**不 veto**（交回模型）；`verify.mjs --cmd` 里用**核心真实代码**跑单/双参数两种调用做回归 |
| **改了源码忘了 deploy** | 测的其实是部署目录里的旧副本（改了 `index.js` 没跑 `deploy.cmd`），结果排查半天现象对不上 | `verify.mjs --cmd` 现在逐个文件比对源码与部署副本（`index.js` / `plugin.json` / `search-command.mjs`） |
| **`api.log` 不进日志文件** | 出问题时翻 `data/logs/qq-agent-<日期>.log` 找不到本插件任何一行记录 —— 只能靠猜 | 关键日志同时走核心的 `logger`（动态 import，拿不到就退回 `api.log`），日志里能看到 `[video-downloader] …` |
| **钩子的"壳"被热重载互相摘掉** | 指令发出去**完全没有反应**：没日志、没图、模型也没被叫醒 —— 连"未认领"都打不出来，日志里什么都查不到（2026-10-17 真实现场：`我要看大肥鱼的图` 两条消息全被吞） | `onIncoming` 是多插件共用的链表，每个插件都在 `dispose` 时"把壳摘掉"。热重载时新旧实例的 install / dispose 在同一秒里交错（日志里同一时刻两条 `已挂载` 就是两个实例），旧实例 dispose 读到的是**新实例刚写下的记录**，于是把新实例的壳当成自己的还原掉 —— 链上只剩原方法。现在：① `dispose` **只放弃实现指针、绝不摘壳**（壳留着无害：没有实现就把消息原样交回下游）；② 挂载/自愈前用**探针**确认"链上还调不调得到我"（探针 `this` 传 `{paused:true}`，一路落到原方法也只会被第一行 `return` 掉，绝不排会话、不叫醒模型）；③ 30 秒看门狗探一次，断了就自动重挂。`verify.mjs --cmd` 加了两条回归：`dispose 不摘壳`、`壳被摘掉后 install 自愈重挂` |
| **内置工具住在 `plugins/` 里 → 它读自己的文件就会让 QQ Agent 全量重扫插件** | `开始搜图了` 之后**再也没有下文**：收尾那句和图片都不来，日志里连错误都没有（2026-10-17 真实现场，两条指令全中） | `fs.watch(plugins/, {recursive:true})` 会报出**纯读取**引起的 NTFS 最后访问时间变化（实测：只 `readFileSync` 一遍 `tool/src/core/*.js` 就能触发 `change` 事件）。于是工具的 CLI 一启动读自己的源码 → 热重载 → `dispose()` → 把正在跑的子进程杀掉，Promise 永不 settle。现在：① CLI 改跑**数据目录里的副本**（`data/video-downloader/tool-src`，只有 `src/` + `package.json`，二进制仍由 `VIDEOGRAB_TOOLS_DIR` 指到数据目录），副本不在监听范围内；② 热重载**不再杀在跑的子进程**（让任务跑完，10 分钟兜底强制收），这样"重载"最多让日志多条记录，不会吞掉用户等着的图 |
| **插件内部 `import('./xxx.mjs')` 没带查询串** | 改了 `search-command.mjs`（新加「再来点…的图」这类真实说法）热重载十次也不生效，线上只有一句干净的「句式不匹配」，看起来像识别逻辑写错了（2026-10-17 踩到：文件 20:54 改的，进程 20:36 就起来了，一直跑的是旧模块） | 热重载只给 `index.js` 加了 `?t=`，它内部的相对 import 没有查询串 → ESM 注册表永远返回**进程最早加载的那份**。现在 `loadSearchMatcher()` 用 `new URL('./search-command.mjs', import.meta.url) + ?v=Date.now()`；核心补丁那边 import `card-links.mjs` 也带上按分钟取整的 `?v=`（`card-links/apply.mjs` 的补丁文本同步改了，重新打补丁不会退回旧写法） |
| **直播时长上限跟着 `looksLive(url)` 一起被判掉了** | 群里发直播短链（`https://b23.tv/8FCCLtv`，302 之后才是 `live.bilibili.com`）→ 机器人一路录到插件自己 `timeoutSec` 被杀，留下 213MB 的 `.flv.part`，群里只收到一句"下载超时"（2026-10-17，同一天 `00:59` 还有一次 74MB 的 `.mp4.part`） | 原来"要不要 `--live`"和"要不要 `--live-seconds`"绑在同一个 `looksLive(url)` 判断上，短链两样都没传 → 工具进了内置录制引擎，却按"录到手动结束"跑。现在拆开：`--live-seconds` **无条件传**（语义只是"如果是直播，最多录 N 秒"，对普通视频零副作用、零额外开销；实测短链只靠它 20 秒准时收尾并转封装成 mp4），`--live` 仍按 URL 提示传（它会强制多跑一次 yt-dlp `getStreamInfo`，普通视频白等几秒、还多打一次 B 站 API 更容易被限流）；另外插件的子进程超时改成 `max(timeoutSec, 录制上限+180s)`，超时错误里带上工具最后几行输出（这次就是靠它才看清"在无限录制"）。`verify.mjs --live` 做回归：真联网录 15 秒，断言"用时远小于超时 + 真发出了媒体段 + 文件在磁盘上" |
| **抖音直播录下来是 HEVC 的 FLV → 转封装必失败 → 群友看到"下载视频出错"** | 抖音直播"下载成功"但发出去的视频播不了：磁盘上要么是 `.flv`，要么是 0 字节的 `.mp4`，偶尔还是个 2.6 秒的片段（2026-10-17） | 三件事叠在一起：① 抖音会给"支持 HEVC 的浏览器"发 **HEVC 的 FLV**（enhanced-RTMP，codec id 12），内置 ffmpeg 6.1 的 FLV demuxer 不认 → `ffmpeg -i` 报 `Video: none ([12]…): unknown codec`，转封装报 `dimensions not set` 并留下 0 字节 mp4；② 直播间页面上同时有一段 2.6 秒的预览 mp4，`pickMediaPair` 原来的打分让 mp4 胜出；③ 插件把 `.flv` 当 video 段发出去，QQ 根本不播。修法：**抓流浏览器挂 preload（`src/core/preload-nohevc.js`；必须 `contextIsolation:false` 才能在页面里改 `MediaSource`）把 `isTypeSupported`/`canPlayType` 里的 hvc1/hev1/h265 全判死** → 播放器退回 H.264 流（实测同样 1920x1080 60fps，只是编码变 h264，转封装一次过）；`pickMediaPair(media, {preferLive})` 在直播场景把 `.flv/.m3u8` 抬到最高分；转封装失败时用 `detectUnknownVideoCodec()` 认出"未知编码"就**明确报错并删掉残file**，绝不把播不了的 `.flv` 当成品；插件侧 `ensureSendableVideo()` 兜底：非 mp4/mov 先无损转封装，转不了就改发**群文件**（至少能下载来播） |
| **两条链接同时进来只下了一条** | 群里连发两条视频链接，只到手一条；另一条**彻底消失**，连失败提示都没有，之后重发同一条还会被判成"正在处理"跳过（2026-10-17 用户报） | 队列和去重状态原来挂在**模块作用域**：第二条链接在 `waiting` 里排队时，只要发生一次热重载，`dispose()` 里的 `waiting.length = 0` 就把那个 Promise 直接丢掉 —— 永不 resolve，视频人间蒸发（而热重载在装了内置工具的环境里一秒能触发好几次，见下面那条）。现在 `active/waiting/recent/running` 全挂到 `Symbol.for('qq-agent.video-downloader.downloadState')` 上（跨实例共享），`dispose` **绝不清队列**、只打一行"队列里还有 N 条，交给它跑完"。`verify.mjs --queue` 四条回归：两条并发都完成、**不同群同一条链接各下一份**、同群同链接只下一次、**排队期间 dispose 也不丢任务** |
| **去重键只有 url → 不同群的同一条链接只下一个** | 同一个链接被同时发到两个群（转发机器人常干的事：两个群的消息时间戳一模一样），只有先到的那个群收到视频，另一个群什么都没有，日志里只有一行"链接刚处理过或正在处理，跳过"（2026-10-17 真实现场：`b23.tv/Jp5RK1V`、`b23.tv/xgKyXvh` 都是两个群同一秒发来的） | "10 分钟内不重复下载"原本按 **url** 记，等于"跨群也去重"。可两个群各贴一次是两拨互不相干的观众各要一份，不是重复请求。现在去重键改成 **`会话::链接`**（例如 `group:1029945156::https://b23.tv/xxx`）：跨群各下一份，同群重复贴（或同一条消息被核心派发两次）仍然只下一次。`verify.mjs --queue` 里一条用例专门压这个 |
| **Edge 的 cookie 读不出来（文件被独占 / v20 解不开）** | 想让机器人继承 Edge 的登录态，结果要么报"读不到"，要么一条都没导出来 | ① Edge 运行时会**独占** `<Profile>\Network\Cookies`，连只读 `File.Open(...,ReadWrite)` 都拒绝 —— 只能复制快照，失败就返回 `{locked:true}`、15 分钟内不重试（否则每次下载都撞锁刷屏）；② Edge 127+ 有部分 cookie 走 **app-bound 加密（v20）**，密钥绑在浏览器私钥上，外部进程做不到，只能如实跳过并报条数；③ DPAPI 纯 JS 调不到，走一次 `powershell.exe` 的 `ProtectedData.Unprotect`（本机同用户，等价于"以自己身份解密"），解出来的 32 字节密钥按 mtime 缓存；④ 现代格式是 `v10`+nonce(12)+密文+tag(16) 的 AES-256-GCM，老格式才退回 AES-256-CBC（IV=16 空格）。`verify.mjs --edge` 里造了一条 v10 cookie 做解密回归 |
| **抖音图文帖 6 张只下 1 张** | 抖音图文帖有多张图，桌面版和插件都只存/只发一张（2026-10-17 用户报） | 四个坑叠在一起，缺一个都还是 1 张：① 页面抽取脚本给的 `scope` 是**短标记** `note/slide/junk`，而 `images.js` 的 `NOTE_SCOPE` 只认 e2e 路径里的 `note-detail` → `inNote` **恒为空**，正文区那 6 张全被"收敛"掉，只剩轮播翻出来的 1 张（最终根因）；② 收敛时按 **URL 全串**比，同一张图在结构化数据/网络请求/DOM 里查询串不同 → 明明在正文区也被过滤；现在按 `baseImageKey` 归一化比；③ 轮播"当前张"用 `imgs.find()` 取，可多张图**同时都在 DOM 里**，永远返回第一张 → 翻页判定"没变化"直接到底；现在按"真的显示在视口里"选；④ 就算轮播只翻到 1 张，也要和正文区的图**合并**（轮播给顺序，正文区补漏）。实测同一条帖子：1 张 → **6 张全下**（`verify.mjs` 里加了 `pickPostImages` 的回归；`VIDEOGRAB_DEBUG_PICK=1` 可打印各阶段数量） |
| **图文帖里混着视频 → 配图被吞** | 一条抖音帖既有多张图又有视频，结果只发视频、图片一张没有 | 工具里"抓到视频地址"分支直接 `return this.#finish(...)`，图片那段永远走不到。现在视频照下，若正文区还有配图就下到**同一个目录**并把目录交给上层（`finalizeVideo`）；插件侧 `collectArtifacts(..., {recursive:true})` 往子目录里走一层，`deliver()` 改成"视频段和图片段都发，描述用「；」拼起来"。`verify.mjs --zip` 里新增一条用例：给一个「视频 + 图片子目录」的产物，断言视频段 1 个、图片段 3 个都发出去了 |
| **图文帖里的动图存成了普通图片** | 抖音图文帖里明明是会动的图，存下来/发出去却是一张静止图（2026-10-17 用户报，示例 `v.douyin.com/k-Z0crSqHk8`） | 抖音的"动图"在 `url_list` 里只是**静态首帧**（`...~tplv-dy-aweme-images:q75.webp`），我们一直下的就是它；真正的动画在同一条目的 `images[i].video.play_addr.url_list`（2~3 秒的 mp4）。另外新版页面已经没有 `window._ROUTER_DATA` 了，原来的结构化数据来源是空的。现在：① 页面脚本里直接（带登录态）请求 `/aweme/v1/web/aweme/detail/` 拿结构化数据，解析出 `videoUrl` / `durationMs`；② 动图下那段 mp4 → ffmpeg 转 **GIF**（QQ 里 gif 必定动，webp 动图显示不稳），体积按 480/10 → 360/8 → 240/6 逐档压到 ≤2.5MB（一开始 540/12 实测单个 7MB+，太夸张）；③ 转不成 GIF 就保留 mp4 当视频发，绝不退回"一张静止图"；④ 动图的**静态首帧**同时从普通图片里排除，不会同一张图既存 webp 又存 gif。实测示例帖：**3 张全动**（29/20/26 帧，1.3–2.2MB），插件发 `image:gif ×3` |
| **同一张图被下两遍（6 张变 7 张）** | 修好"6 张只下 1 张"之后，同一条帖子变成了 7 张，其中两张完全一样 | 同一张图会挂在**不同 CDN 分片**上（`p3-pc-sign.douyinpic.com` / `p9-pc-sign.douyinpic.com` / `p26-sign.douyinpic.com`），而 `baseImageKey` 的去重键里含主机名 → 结构化数据来的 p3 和 DOM 来的 p9 被当成两张。现在把分片前缀剥掉、只留基础域名（douyinpic.com / douyinvod.com / byteimg.com / hdslb.com / pximg.net / xhscdn.com）再去重。实测：6 张，无重复 |
| **抖音短链下载失败，报一串 ConnectionResetError** | 群里发 `https://v.douyin.com/xxxxx`（短链），机器人回"这个视频没下下来"，日志里是 `[generic] … Unable to download webpage: ConnectionResetError(10054)`（2026-10-17，用户贴了完整报错） | yt-dlp **不认这种短码**，会退化成 generic 提取器、用普通 UA 去 GET 短链 → 抖音直接重置连接。修法：① **抖音短链先走内置浏览器**（跟着 302 就到 `www.douyin.com/video|note/<id>`，视频/图文/直播都能处理），浏览器不行再退回 yt-dlp；② 浏览器撞到「验证码中间页」时**明确报出来**（`this.lastBlockedReason`），不再把 yt-dlp 那串连接重置甩给用户，插件 `friendlyOf` 也会翻成一句人话；③ 顺手把 `--cookies` 的登录态**灌进抓流浏览器的 session**（`applyCookiesToSession`，辅助进程用临时 JSON 传），有登录态就不容易被风控。**注意**：这一条只能改善"报错看不懂"和"绕路"，真正过验证码仍需人类在桌面版内置浏览器里过一次（cookie 就会留下来） |
| **抖音视频下完多出一堆无关图** | 下一条抖音视频（`v.douyin.com/ao7xoHq5CiI` 这类），视频本身是对的，但文件夹里/群里多出 14 张毫不相干的图（20~40KB 的缩略图）——2026-10-17 第二条报障 | 上一轮"图文帖里混着视频 → 两样都要"改得太宽：`finalizeVideo` 无条件把 `pickPostImages(page.images)` 当成"这条帖子的配图"。可**视频页**上根本没有正文图，页面上那些 `<img>` 全是头像/封面/推荐流缩略图，于是全被当成配图下了下来。现在加了两道门：① `finalizeVideo` 只在**确认是图文帖**时附带配图（`notePost` 来自 aweme detail 结构化数据，或 URL 本身就是 `/note/`）；② `!pair.video` 那条回退路径同理，只有图文帖/专栏页才去抓页面图片，普通视频页抓不到视频就老实报"没找到视频"，不再拿无关图凑数。实测同一条链接：**只剩 1 个 mp4**；三条图文/动图链接回归全部正常（6 webp / 3 gif / 3 webp） |
| **B 站专栏突然全下不了（`Cannot access 'isNotePost' before initialization`）** | 上一轮修完"抖音视频下完多出无关图"之后，**所有"页面里没有视频流"的站点**（B 站专栏、图文页…）立刻报 TDZ 错，白等 50 秒然后失败（2026-10-17 现场） | 防"无关图"那道门用的 `isNotePost` 是在下面分支里 `const` 声明的，而上面 `if (!pair.video …)` 分支先用了它 —— `const` 的**暂时性死区**。抖音链接之所以没露馅：note 走的是另一条 `#downloadImages` 通道，视频页 `pair.video` 为真便短路跳过了那段。现在 `isNotePost` 统一提到 `pair` 之后、任何使用点之前声明。**教训**：这类"顺手加的判定"一定要跑一遍真实链路的三种页面（视频 / 图文 / 专栏），别只测触发它的那一条 |
| **大视频（>100MB）明明发成功了，机器人却说"下载失败"** | 133.5MB 的视频：日志里先 `OneBot send_private_msg 超时（90 秒未完成）`，再回退裸路径 `retcode=100 ENOENT … realpath 'D:\…\QQ%20Agent\…'`，群里最后收到"这个视频没下下来"——**可用户确认文件当时已经收到了**（2026-10-17 现场） | 两个独立问题：① **超时被当成了失败**：core 的发送超时是 90 秒（`src/onebot.js` 的 `SEND_TIMEOUT_MS`），而协议端还在传腾讯，最后真的传成功了。现在 `isSendTimeout()` 把这类错误单独拎出来：**不重试**（重试就是发两遍 133MB）、**不报失败**，只记一行"可能仍在传输"；② **回退裸路径没解码**：`sendSegments` 只削了 `file:///` 前缀，交给协议端的还是 `%20`/`%E3%80%90` 这种百分号串，`realpath` 必然 ENOENT —— 现在 `plainPathFromUri()` 会 `decodeURIComponent` + 盘符/反斜杠规范化，**只对"明确失败"（找不到文件、格式被拒）才重试**。另外新增：超过线但**时长 ≤10 分钟**的视频先压缩（`shrinkVideoToFit` crf 26→30→34、长边 1280→960），压到线下就发成正常视频消息；超过 10 分钟直接跳过压缩（37 分钟 1080p 才 420kb/s，重编码十几分钟还未必更小）。明确失败时若拿得到 `onebot`，再退到专用上传接口（`upload_group_file`/`upload_private_file`，10 分钟超时）。实测：1.6MB 短片压到 857KB 后按视频发出；133.5MB/37 分钟那条→跳过压缩、发送超时按"可能仍在传输"处理、**只尝试 1 次、不重复上传** |
| **同一个视频有概率发两次** | 一天里两次：先 `转发完成 … https://b23.tv/EkiPKno?share_medium=android&share_source=qq&bbid=…&ts=…`，13 秒后又 `转发完成 … https://b23.tv/EkiPKno`（2026-10-17 现场，用户报"有概率发两次"） | 根因在**链接提取**：`src/media-links.js` 有两条正则 —— 一条收带协议的完整链接、一条专门兜"裸短链"（`b23.tv/xxx`），于是同一条卡片消息被抽出两个 URL：一个带 `?share_medium=…&ts=…`、一个是干净短链。两者字符串不同 → 两个去重键 → 各下一次、各发一遍（原来只归一化了尾部斜杠，没管查询串）。修法两层：① `canonicalUrlKey()` 归一化去重键 —— 短链域名（b23.tv / v.douyin.com / v.kuaishou.com / t.cn …）**整段丢弃查询串**，其它站点只保留 `p/list/index/page/v/…` 这类会影响内容的参数，去掉 `share_medium / share_source / bbid / ts / spm_id_from / vd_source`；② 发送端再加一道兜底 `sentSigs`（会话+文件名+字节数，10 分钟）：即使同一个视频被**不同链接**触发（短链 vs 完整 URL），第二次也只记一行"刚发过，已跳过"。`verify.mjs --queue` 新增三条回归：分享参数不影响去重键、同群两种写法只下一次、同一个视频第二次不再发 |
| **pixiv 搜图失败，群里一点反馈都没有** | 群里发「我要 xxx 的图」，搜图挂了（代理没开 / Pixiv 风控 / 工具异常）—— 群里**一个字都没有**，用户以为机器人没理他；日志里其实有一行失败原因（2026-10-18 用户报） | 「我要 xxx 的图」是**确定性指令**：钩子认出后会把这条消息 **veto** 掉（`handled:true`），模型**根本不会被叫醒** —— 于是"失败"这件事故障现场没人说话：`performSearchRequest` 只把原因写进日志（旧代码 `if (out.ok) log(…)`，失败分支连日志都省了），`handleImageRequest` 那条备用路径也一样。现在：① 新增 `searchFailureText()`，把原始错误翻成一句人话（连不上 Pixiv / 超时 / 风控 403 / 没搜到 / 工具没装好）；② 失败时 `sayFailure()` **强制发一条**（`say(..., {force:true})` 绕过 `download` 模式的"群里一个字都不发"，因为用户明确下过指令；尊重 `notifyFailure=false`）；③ 图下好了但**发不出去**（格式被拒 / 超时 / 体积超限）也走同一条反馈；④ 工具那条路（模型还在场）在返回值里明确要求"把失败原因用一句话告诉对方"，避免模型拿到 `isError` 后一言不发。`verify.mjs --search` 新增两条回归：假工具必定失败时群里**必须收到 1 句**失败提示、`notifyFailure=false` 时**不许打扰**；`--cmd` 再加一条走真实钩子链的端到端断言 |
| **搜不到就没了：公开接口查冷门词经常空** | 「我要 XX 的图」里的 XX 稍微冷门（新作品 / 日文原名 / 小标签），公开检索接口（lolicon 聚合）返回空 → 直接"没搜到"，可 pixiv 自己明明搜得到（2026-10-18 用户要求改进） | 工具侧新增 `searchPixivNative()`：打官方 `https://www.pixiv.net/ajax/search/artworks/<kw>`（带 `Referer`，登录态可选），`searchPixiv()` 在公开接口**一条都没搜到**时**自动回退**到它，并返回 `backend: 'pixiv-native'`；CLI 另有 `--no-pixiv-native` 可关掉。**取图仍然走 pixiv.re 反代**，所以只有"搜索"这一步需要能连上 pixiv.net（代理或登录态）。插件侧：结果里带 `backend`，来自原生搜索时答复里加一句"（公开接口没搜到，已自动改用 Pixiv 原生搜索）"；两条路都断时提示改成"公开接口没搜到，改用 Pixiv 原生搜索也连不上（原生搜索要挂代理）"。`verify.mjs --search` 用 fixture 驱动两条回归：公开接口空 → `backend=pixiv-native` 且原生只调 1 次；`nativeFallback=false` 时**不碰**原生接口 |
| **图发了但群里看不到（5 张图一条消息被 QQ 整条丢掉）** | 搜到 5 张图，协议端日志显示 5 张**全部上传成功**、`发送：[图片]×5`、API 也回了 message_id，插件记成"已发送 5 张"，可群里**一张都没收到**——只有「开始搜图了」「图片正在发送」两句文字（2026-10-18 用户报） | 关键证据在协议端日志：同一天另一批 **3 张小图**发完有 `[Event] [自身] … [图片] [图片] [图片]`（QQ 把消息回推给自己，说明真发出去了），而这批 5 张（含一张 **4.5MB PNG**）**没有任何回推** —— 即"接口成功但消息被服务端丢弃"。修法两层：① `ensureSendableImages()` 增加**体积归一化**：单张超过 `QQ_IMAGE_MAX_BYTES`（3.5MB）就用 ffmpeg 逐档压（2048/q3 → 1600/q5 → 1280/q7），实测那张 4.31MB PNG 压到 520KB；② 发送改成**一张一条消息**（`deliver()` 里逐张 `sendSegments`，间隔 400ms），单张被拒不再连累其余，失败也能定位到具体哪张。`verify.mjs --zip`/`--cmd` 同步断言"每条消息只含 1 个 image 段" |
| **日文关键词的指令不被认领（「来点レイジ的图」→ 句式不匹配）** | 明明是最标准的句式，钩子却不认领（日志：`未认领（句式不匹配）… text=@陈千语 来点レイジ的图`），只好交给模型去调工具 —— 多花 token、还多几秒延迟（2026-10-18 现场） | `search-command.mjs` 的"关键词总得有点实质内容"校验写的是 `/[\p{Script=Han}A-Za-z0-9]/u`，**只认汉字/拉丁字母/数字**：假名（レイジ / ゆかり）、韩文、俄文全被判成"没内容"直接返回 null。pixiv 的标签绝大多数是日文，这条等于把最常用的场景挡在门外。改成 `/[\p{L}\p{N}]/u`（任何语言的字母/数字都算）。`verify.mjs --cmd` 加了 `来点レイジ的图` / `@陈千语 来点レイジ的图` / `来点ゆかり的图` 三条回归，同时保留「来点图」「刚刚那张图」等不该命中的用例 |
| **搜图"只打两行横幅就没下文"（工具静默退出，退出码 0）** | 群里发「我要 XX 的图」，本机日志只有两行 `ⓘ 检测到系统代理 …` / `ⓘ 搜索 Pixiv：…`，插件报"工具退出码 0 且没有产出任何文件"；更糟的是失败提示被翻成"**连不上 Pixiv（要挂代理）**"，可用户的代理明明开着（2026-10-18 用户报） | 两个 bug 叠加：① **代理隧道半死时底层 fetch 既不 resolve 也不 reject**，`AbortController.abort()` 对它无效 —— 15 秒定时器烧完后事件循环里再没有 handle，Node **静默退出且退出码 0**，一行错误都不打。修在 `src/core/http.js`：给 fetch 加"一定会 reject"的 backstop（超时+2s），`res.arrayBuffer()` 也套 `withTimeout()`（body 流卡住同样会挂死）；`src/cli.js` 再加 `beforeExit` 兜底 —— 只要 `main()` 没结算就打印"有请求始终没有返回"并置退出码 1，绝不让它伪装成成功。② **错误提取把横幅当成了原因**：`runPixivSearchToolCli` 原来取 stdout 最后两行，正好是横幅，于是 `searchFailureText()` 看见"代理"两个字就判"要挂代理"。现在只取**非 `ⓘ` 行**、优先 stderr，并把 code/signal/两路字节数写进日志；`searchFailureText` 也只在**真的出现连接类错误**（ECONNREFUSED/ETIMEDOUT/网络错误…）时才提代理。另外反代 500/404 现在是**自动重试一次**（`searchAndDownloadPixiv`），实测 `奶蛙` 从"0 张 + 静默"变成正常下载或明确报错 |

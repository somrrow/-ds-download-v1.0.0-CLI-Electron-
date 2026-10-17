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

## 搜图命令收到之后：只下载 / 只发图 / 图+两句固定话

搜图那条链路（模型调用 `pixiv_search` 工具 + 「我要 xxx 的图」这类固定句式）和"有人贴链接"
那条链路（`media.download`）**分开控制**。搜图用完的产物怎么处理由 `searchSendMode` 决定：

| 取值 | 行为 | 什么时候用 |
| --- | --- | --- |
| `download`（默认） | **只下载**：图留在本机，群里一个字都不发（图也不发）；下载情况写进控制台日志 + 工具返回值，并明确要求模型**不要发言** | 只想把图收下来、不想让机器人说话的场合（静默收集） |
| `images` | **只发图**：图（超出上限照旧打包成 zip 当群文件）发到会话，但不发任何文字 | 想让群友看到图、又不想多话 |
| `send` | **图 + 两句固定话**：收到指令先发「**开始搜图了**」，图片发完再发「**搜图结束了**」 | 想让人一眼看出"在搜了 / 搜完了" |

实现上的三个要点：

- `send` 的两句提示语在 `performSearchRequest` 里发：**开始那句在下载之前**（收到指令就吱一声）、
  **结束那句在图片真的发出去之后**（搜图失败就不发"搜图结束了"，免得群里以为有图）；
  发提示语失败只记日志，绝不影响搜图本身；
- 这两句**由插件自己直接发**（走核心的 `sender.sendTextBatch`：限频 / 去重 / 留档都在里面），
  **不经过模型**：固定句式那条路上模型压根不会被叫醒（钩子 veto），
  模型即使在别的路径调了搜图工具，返回值里也会明确要求它别复述这两句；
- 工具返回值里带着**这次的模式**与"要不要说话"的明确交代（`download` 模式下会写
  "不要调用任何发送/回复类工具"）—— 模型不必猜，也不会被老提示词带偏；
- `deliver({ quiet: true })` 只压制**说明文字**，媒体照发，返回的字符串照旧带情况（进日志与返回值）。

```bash
node qqagent-plugin/verify.mjs --search   # 脱网确定性：三种模式的计划（含两句提示语）+ quiet 压文字
node qqagent-plugin/verify.mjs --cmd      # 里面还有一条 send 模式端到端：开始搜图了 → 图 → 搜图结束了
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

> ⚠️ 与「Pixiv 来张图（自建）」插件功能重叠：两个都开着时模型会看到两个搜图工具。
> 建议只留一个 —— 那个插件有按会话的 R18 分级（带主人身份校验）；本插件胜在**不需要代理**、
> **多图作品会把每一页都补齐**、图多时自动打包成压缩包。

### 踩过的坑

- **`-n` 不是数量**：本工具里 `-n` 早就是 `--name`（输出文件名），写成 `-n 2` 会让所有图叫 `2.png`；
  数量必须用 `--count`。
- **图片帖判定必须在预探测之前**：pixiv 链接的判定根本不需要访问 pixiv.net，而预探测（请求作品页）
  在没代理时会先超时失败，任务就此结束 —— 免代理那条路**根本没机会跑**。所以下载流程里
  把"是不是图片帖"提到预探测之前了（`src/core/downloader.js`）。

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
- 压缩包用 Windows 自带的 `tar.exe` 打（Win10 1803+ 内置），失败自动换 PowerShell 的
  `Compress-Archive`（脚本走 `-EncodedCommand`，中文标题不会乱码）。

## 默认行为（都可在「插件」页签里改）

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| 认领哪些链接 | `known+direct` | 已知平台 + 像直链的地址（.mp4/.m3u8/.mp3…）；`all` = 任何链接都试 |
| 代理地址 | 空 | 空 = 跟随 Windows 系统代理；填了就给工具加 `--proxy`（pixiv 这类站点需要） |
| 清晰度 | `best` | 透传 `-q`；群里转发建议 720/1080 |
| 图文帖最多发几张 | 9 | 超过的部分打包成压缩包 |
| 图片超出上限 | `rest` | `rest` = 剩下的打包 / `all` = 包里放全部 / `off` = 不打包 |
| 压缩包上限 | 200 MB | 超过就只回一行文字 + 本地路径 |
| 图片转 jpg 再发 | `risky` | 只转 QQ 不认的格式（avif 等） |
| 搜图结果怎么处理 | `download` | `download` = 只下载不发消息 / `images` = 只发图不发字 / `send` = 图 + 「开始搜图了」…「搜图结束了」两句固定话 |
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
node qqagent-plugin/verify.mjs         # 真实网络：Pixiv / 抖音图文 / B站专栏 三条链路
```

`check.mjs` 是**部署前必跑**的：清单 JSON 少一个逗号、字符串里多一个英文引号，
QQ Agent 只会记一行 `❌ 清单解析失败`，插件**静默不生效** —— 我这次就踩了两次
（第一次漏逗号、第二次字符串里写了 ASCII 引号），所以把校验脚本固化下来了。

## 已踩过的坑（都已在代码里处理）

| 坑 | 现象 | 处理 |
| --- | --- | --- |
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


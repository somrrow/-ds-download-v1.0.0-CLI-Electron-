# 肥鱼当劳（ds-download）

把链接丢进来就能下载视频的本地工具：**命令行 + 桌面图形界面**共用同一套下载引擎，零运行时依赖（只用 Node 内置模块）。

```
粘贴链接 → 自动识别类型 → 选择清晰度 → 下载到本地
```

> **只想直接用、不想折腾环境？** 去本仓库的 [Releases](../../releases) 页下载
> `ds-download-<版本>-win-x64.zip`：解压后双击 `ds-download.exe` 即可，
> 自带 Electron 运行时与 yt-dlp/ffmpeg，**不需要安装 Node**（Windows 10/11 64 位）。
> 从源码构建见文末「打包与分发」。

## 功能一览

| 能力 | 说明 |
| --- | --- |
| 直链视频 | `.mp4/.webm/.mov/.mkv/.flv/.mp3/.m4a` 等，支持 **Range 断点续传**、失败保留 `.part` 可续传 |
| HLS / m3u8 | 主列表自动选流（best / 2160 / 1440 / 1080 / 720 / 480 / worst / 仅音频）、分片并发下载、失败自动重试、**AES-128 分片解密**、`EXT-X-BYTERANGE`、fMP4(EXT-X-MAP)、VOD 断点续传、**直播录制可随时结束**（Ctrl+C 或界面按钮，已录部分自动保存、有 ffmpeg 时自动转封装 MP4） |
| 网页链接 | 自动从 HTML 里提取 `og:video`、`twitter:player:stream`、`<video>/<source>`、JSON-LD 与内嵌地址；提取不到时交给 yt-dlp |
| **图片帖（图文）** | 链接是**抖音图文**（`douyin.com/note/…`、分享页、或 App 分享短链 `v.douyin.com/…`）、**Pixiv 插画**（`pixiv.net/artworks/…`），或**页面里只有配图没有视频的文章页**（B 站专栏 `read/cv…`、B 站图文 `opus/…`、小红书笔记、微信/知乎长文等）时，自动改下**图片**，**数量不设上限**（有多少有效图就存多少）。长文章的图片是懒加载的，程序会**先滚动整页把图都触发出来**再收集。过滤规则是「先按正文来源收敛，再按体积兜底」：抖音走轮播逐张翻页、Pixiv 走官方接口取原图、B 站只认 `bfs/article/` 下的正文图、其它站点优先正文区域 → 再统一丢掉头像（`bfs/face`、`avatar`）、用户装扮与图标资源（`bfs/garb`、`bfs/static`、`jinkela`）、前端文件（`.js/.css/.json`）、表情贴纸，并把同一张图的多个尺寸变体（抖音 `~tplv…:1080:1440`、B 站 `@1192w` / `@128w_128h_1c`）合并成一张、留最清晰的那个；最后再探一次体积，剔除小于 20 KB 的小图（表情、缩略图）。多图放进以标题命名的子目录并按 `001.jpg`、`002.jpg` 编号，单图直接存文件 |
| **Pixiv 不需要代理** | `pixiv.net` 大陆直连不通，所以 Pixiv 默认走**反代**：`pixiv.re` + 公开检索接口 `api.lolicon.app`。**先反代、反代拿不到才退回官方接口**（`--pixiv-source api|mirror|auto` 可强制）。实测反代给的就是**原图**（字节数与官方一致）、连 Referer 都不用；多图作品会把**每一页**都补齐（`-2.png`、`-3.png`… 逐页探测，404 即到底）。界面里有 **「Pixiv 搜图」搜索框 + R18 开关**，命令行是 `vgrab --pixiv-search "初音ミク" --count 3` |
| 各类视频站点 | 通过 **yt-dlp**（首次使用自动获取，约 20MB）支持 B 站、YouTube、抖音、Twitter/X 等上千个站点 |
| **内置浏览器兜底** | yt-dlp 解析不了的站点（如抖音：反爬签名 yt-dlp 尚未实现），自动用应用内置的 Chromium 渲染页面、监听播放器请求抓出真实视频/音轨地址，再用内置下载器下载并合并音视频 —— 不需要你装插件、导 cookies、也不用手动关浏览器。渲染时会拦掉 `bytedance://` 这类「打开 App」深链，避免 Windows 弹出「获取打开此链接的应用」对话框 |
| DASH / 其他 | 交给 yt-dlp 处理（合并音视频需要 ffmpeg） |
| 音视频合并 / 转封装 | 有 ffmpeg 时自动把 TS 无损转封装成 MP4、合并分离的音视频轨；**首次遇到需要合并的内容会自动获取 ffmpeg**（约 30MB，可用 `--no-auto-ffmpeg` 关闭） |
| 报错提示 | 把 yt-dlp 的英文报错翻译成可操作的中文建议（需登录 → 提示用 Cookie；地区限制 → 提示代理；格式不可用 → 提示装 ffmpeg 或换清晰度） |
| 编码偏好 | 默认 **H.264 + AAC**（Windows 自带播放器、剪辑软件、老设备都能直接播）；可选 HEVC / AV1 / 画质优先（`--codec best`） |
| **下载历史** | 每次任务的结果都会记录（成功/失败/直播录制、大小、时长、引擎、保存路径），默认显示最近 **20 条**，条数可自己设置；界面里每条支持「重下 / 播放 / 文件夹 / 复制路径 / 删除」，也可一键清空。历史文件 `tools/history.json` 由命令行与界面共用 |
| **智能识别链接** | 直接粘贴 App 的整段分享文案也能用：自动从中文、话题标签、表情符号里挑出有效链接（支持一条文案多个链接、去重、无协议的裸域名如 `v.douyin.com/xxx`），界面与命令行都生效 |
| **代理自检 / 热生效** | 界面里「代理地址」旁有 **「测试代理」** 按钮，命令行 `vgrab --check-proxy`：对几个代表性站点各探测两次（直连 vs 经代理）并给出明确结论（可用 / 不生效 / 地址写错）。改完代理**立即生效，无需重启**——会同时作用到内置浏览器、yt-dlp 与内置下载引擎；没填代理时自动跟随 Windows 系统代理 |
| 其它 | Cookie 文件 / 从浏览器读 Cookie、代理、自定义 UA/Referer/请求头、批量下载、`--json` 输出、任务取消 |
| **登录下载高画质** | 用**应用内置浏览器**登录一次（B 站扫码 / 抖音扫码 / 任意站点），登录状态持久保存并导出成 cookies，之后 yt-dlp 与内置引擎都会自动带上 —— 可下 1080P+ / 4K / 大会员 / 需登录内容。不用装导出插件，也不用关闭你日常用的浏览器 |
| **直播间**（B站 / 抖音 / Twitch 等） | 自动识别直播页面（yt-dlp 报 `is_live`）后切换到内置录制引擎直接拉流（B 站直播走 HLS、抖音直播用内置浏览器抓到的 FLV）**并自动选最高清晰度档位**（B站直播登录后即「原画」，失败自动降档重试），**随时可以结束并保存**；结束时自动转封装 MP4 并把直播的绝对时间轴归一到 0 |

## 快速开始

需要 **Node.js ≥ 18**（本机已装 v24）。Electron 依赖已安装好；换机器时执行一次 `npm install` 即可。

### 已打包的免安装版（双击 exe）

```
dist\ds-download-1.0.2-win-x64\ds-download.exe     ← 双击即可，不需要 Node
```

不用装 Node、不用 npm install，包里自带 Electron 运行时与 yt-dlp/ffmpeg（首启动会自动复制到
`%APPDATA%\ds-download\tools`）。整个目录拷到哪台 Windows 上都能跑；要发给别人就发
`dist\ds-download-1.0.2-win-x64.zip`（对方**先解压**再双击 exe；没签名的 exe 第一次打开
可能被 SmartScreen 拦一下，点「更多信息 → 仍要运行」即可）。

自己重新打一份包（改完代码后）：

```powershell
npm run package          # 生成 dist\ 下的便携目录 + zip
npm run package:dir      # 只要目录，不打 zip（调试用）
npm run package:shortcut # 顺手在桌面放一个快捷方式（名字是「肥鱼当劳」）
npm run package -- --no-tools   # 不随包带 yt-dlp/ffmpeg（首次使用时应用自己下载）
```

### 图形界面（源码方式）

双击 `启动界面.cmd`，或者命令行执行：

```powershell
npm run gui
```

界面里粘贴链接（支持多行、支持直接拖链接进窗口）→ 点「开始下载」。左侧可展开「下载选项」设置保存目录、清晰度、编码、并发数、Cookie、代理等；右侧显示每个任务的进度条、速度、剩余时间，完成后可一键播放 / 打开文件夹 / 复制路径。**直播流**任务会被标成「录制中」（暖色进度条），按钮变成 **「结束录制」**，随时点一下就会把已录部分保存成成品。

**Pixiv 搜图（不需要代理）**：左侧「Pixiv 搜图」卡片里填角色名/关键词 → 点「搜图并下载」直接下完（**不加载预览图** —— 图已经在本地了，再解码一遍纯属白等，要看就点「打开文件夹」）；或者点「只列出」先看结果再挑：

- 「只列出」会给每个作品铺一张反代缩略图（240×480，几十 KB，**不拉原图**），每条都有勾选框；
- 每条右侧有 **「下载这个」**（只下这一个）；上方操作条是 **「全选 / 全不选 / 下载选中（N）」**；
- 下载完徽标会变成「N 张 · 已下载」，预览图自动换成**本地图**，并可以「打开文件夹」。

**要下高画质（1080P+ / 4K / 大会员内容）先登录**：点右上角「登录」→ 弹出**站点选择窗口**：里面有哔哩哔哩、抖音、YouTube、快手、微博、小红书、X/Twitter、Instagram、TikTok、知乎、优酷、爱奇艺、腾讯视频、Twitch，**也可以在最下面的输入框里填任意网址或域名**（如 `https://www.example.com/` 或 `example.com`）→ 在弹出的浏览器窗口里扫码或输入账号登录 → **关掉那个窗口**即完成。

- **可以逐个登录多个站点**：登录状态会累积保留（按域名存），下载时自动带上对应站点的 Cookie，互不影响；
- 命令行同样支持任意站点：`vgrab --login bilibili` / `vgrab --login https://www.example.com/` / `vgrab --login example.com`；不带参数会列出全部内置站点；
- 登录用的是应用自带的 Chromium，**不读取你日常浏览器的 Cookie 数据**；全部退出点旁边的「退出」。

**输入框右键菜单**：链接输入框（以及保存目录、Cookie 文件等文本框）里右键会弹出「复制 / 粘贴」——选中了就复制选中的，没选中就复制全部；粘贴插入到光标处（支持多行链接）。点击别处 / 按 Esc / 窗口失焦时菜单自动收起。

**一键清空输入栏**：链接框旁的「清空」按钮（快捷键 `Ctrl+Shift+X`）会清掉已粘贴的链接、收起解析结果卡片，并把焦点交回输入框；输入框为空时按钮自动置灰。

**整段分享文案直接粘**：抖音/小红书那种「3.02 复制打开抖音… # 话题 https://v.douyin.com/xxxx/ 复制此链接…」的文案，**不用手动挑链接**，整个粘贴进来点「开始下载」就行 —— 会自动识别出里面的链接（多个链接会一起加入队列并去重）。命令行同理：`vgrab "整段文案"` 或写进 `--batch` 文件都可以。

**下载历史**：界面下方的「下载历史」卡片列出最近的任务（默认 20 条）：文件名、成功/失败、时间、大小、时长、用的引擎；鼠标悬停右侧可「重下 / 播放 / 文件夹 / 复制路径 / 删除」。左上角的「显示条数」可以改保留条数（改小会立即按新条数裁剪已存历史），旁边是「刷新」和「清空历史」。命令行里用 `vgrab --history [条数]` 查看、`vgrab --history-clear` 清空。

### 命令行

```powershell
node src\cli.js "https://example.com/video.mp4"
# 或使用包装脚本（可把项目目录加入 PATH，之后到处都能用 dsdl）
.\vgrab.cmd "https://example.com/master.m3u8" -q 1080 -o D:\影片
```

> 命令别名：`dsdl` / `ds-download` 是现在的名字，`vgrab` / `video-dl` 仍然可用（老脚本不用改）。
> 下面示例里统一写 `vgrab`，把命令换成 `dsdl` 也一样。

常用示例：

```powershell
# 直链
vgrab "https://example.com/video.mp4"

# HLS：选 1080P，存到 D:\影片，8 个分片并发
vgrab "https://example.com/master.m3u8" -q 1080 -o D:\影片 -c 8

# 站点视频（自动使用 / 获取 yt-dlp），指定文件名
vgrab "https://www.bilibili.com/video/BVxxxxxxxx" -q 720 -n 我的视频

# 编码：默认 H.264（兼容性最好）；想省体积或追画质可换
vgrab "https://www.bilibili.com/video/BVxxxxxxxx" --codec av1
vgrab "https://www.bilibili.com/video/BVxxxxxxxx" --codec best   # 交给 yt-dlp 挑（B站通常是 AV1）

# 先登录，再下高画质（1080P+ / 4K / 大会员内容）
vgrab --login bilibili          # 也可 douyin / youtube / 任意网址；登录完成后关掉窗口即可
vgrab "https://www.bilibili.com/video/BVxxxxxxxx" -q 1080
vgrab --logout                  # 退出登录，删除保存的登录状态

# 需要登录才能看的内容：用浏览器 Cookie 或 cookies.txt
vgrab "https://example.com/vip" --cookies-from-browser chrome
vgrab "https://example.com/vip" --cookies .\cookies.txt

# 只解析不下载 / 查看可用清晰度
vgrab --info "https://example.com/page"
vgrab --formats "https://www.bilibili.com/video/BVxxxxxxxx"

# 批量下载（每行一个链接，# 开头是注释），同时下 2 个
vgrab --batch urls.txt --parallel 2

# 直播录制：一直录到手动结束（Ctrl+C 结束时自动保存成可播放文件）
vgrab "https://example.com/live.m3u8" --live

# 直播录制：只录 5 分钟，到点自动结束并保存
vgrab "https://example.com/live.m3u8" --live --live-seconds 300

# 抖音等强反爬站点（自动走内置浏览器渲染兜底）
vgrab "https://v.douyin.com/xxxxxxxx/"

# Pixiv 搜图（不需要代理：公开检索接口 + pixiv.re 反代）
vgrab --pixiv-search "初音ミク" --count 3
vgrab --pixiv-search "猫娘" --list-only          # 只列出命中，不下载
vgrab --pixiv-search "风景" --r18                # 允许成人向（默认只出全年龄）
vgrab --pixiv-search "初音ミク" --json           # 给脚本/机器人用

# 图片帖：抖音图文 / Pixiv 插画（多图自动放进以标题命名的子目录，按 001、002 编号）
vgrab "https://www.douyin.com/note/7693365550072862451"
vgrab "https://www.pixiv.net/artworks/12345678"

# 查看下载历史（默认最近 20 条；条数也可在界面里设置）
vgrab --history
vgrab --history 50
vgrab --history --json          # 给脚本用
vgrab --history-clear

# 环境自检 / 维护
vgrab --doctor
vgrab --check-proxy                      # 代理自检：直连 vs 经代理，给出明确结论
vgrab --check-proxy --proxy http://127.0.0.1:7890
vgrab --check-proxy --json               # 给脚本用（可用/不可用对应退出码 0/1）
vgrab --update-ytdlp
vgrab --fetch-ffmpeg
vgrab "https://www.bilibili.com/video/BVxxxxxxxx" --no-auto-ffmpeg   # 关闭「缺 ffmpeg 时自动获取」
vgrab "https://v.douyin.com/xxxxxxxx/" --no-browser-assist            # 关闭内置浏览器兜底
```

完整选项见 `vgrab --help`。默认保存目录是系统「下载」文件夹。

## 目录结构

```
src/
  cli.js                    命令行入口（进度条、批量、JSON 输出、自检）
  core/
    config.js               路径与默认配置（工具目录、下载目录、设置文件）
    http.js                 统一 HTTP 层：UA / 重试 / 超时 / 流式读取 / Cookie
    probe.js                链接识别（直链 / HLS / DASH / 网页）与网页媒体提取
    progress.js             进度统计（滑动窗口测速、ETA）
    downloader.js           编排层：选引擎 → 下载 → 事件推送（CLI 与 GUI 共用）
    downloads/direct.js     直链下载（Range 续传、写 .part、完成后改名）
    downloads/hls.js        m3u8 解析 + 分片下载 + AES-128 + fMP4/TS + 直播
    ytdlp.js                yt-dlp / ffmpeg 的定位、自动获取、调用与进度解析
    browser-page.js         内置浏览器渲染页面 + 监听网络请求抓视频/音轨地址（抖音等反爬站点兜底）
    images.js               图片帖支持（Pixiv 原图接口 / 抖音图文图片筛选、去重、下载）
    browser-login.js        内置浏览器登录站点、导出 cookies.txt（高画质 / 会员内容）
    browser-guard.js        内置浏览器导航守卫（拦截 bytedance: 等自定义协议深链、限制弹窗）
    history.js              下载历史（追加/条数限制/删除/清空，CLI 与界面共用）
    extract-urls.js         从任意文本（分享文案）里提取有效链接
    util.js                 文件名清洗、格式化、cookies 解析
  gui/
    main.js                 Electron 主进程（窗口、菜单、IPC、设置持久化、预览图缩略）
    preload.js              contextBridge 白名单 API
    renderer/               界面（index.html / styles.css / app.js）
build/
  make-icon.mjs             没图时画一个默认图标（零依赖：自己画像素 + 自己写 PNG/ICO）
  icon-from-image.cjs       把自己的图转成图标（用 Electron 解码；中心裁方 + 多尺寸 ICO）
  make-logo.cjs             把图做成界面左上角的 logo（自动裁留白 → 192px PNG → 抠圆角）
  round-corners.cjs         给图标/logo 抠透明圆角（3×3 子采样抗锯齿）
  img-decode.cjs            读图小工具（nativeImage 只认 PNG/JPEG，别的格式自动用 ffmpeg 转）
  icon.png / icon.ico       生成出来的图标（窗口图标 / 快捷方式 / exe 内嵌）
  icon-source.txt           记住"图标是从哪张图来的"
  logo-source.txt           记住"界面 logo 是从哪张图来的"
  build-package.mjs         打包成免安装便携版 + zip（离线可做，不用 electron-builder）
tests/
  run.js                    离线测试：内置模拟服务器（Range / 加密 HLS / fMP4 / 网页）
  smoke-network.js          真实网络冒烟测试（直链 / HLS / 网页 / yt-dlp）
tools/                      运行时自动存放 yt-dlp.exe、ffmpeg.exe
dist/                       打包产物（便携目录 + zip）
```

## 打包与分发

打包**不依赖任何第三方打包器**（没有 electron-builder / electron-packager），只用
`node_modules/electron/dist` 里那份运行时：

```
dist/ds-download-1.0.2-win-x64/
  ds-download.exe           ← 双击即开（Electron 运行时改名而来，app.isPackaged = true）
  ds-download.ico           ← 快捷方式/资源管理器图标
  *.dll / icudtl.dat / locales/ …       Electron 运行时
  resources/app/            ← 应用本体：src/、package.json、README.md、icon.png、tools/（种子）
  使用说明.txt
  ds-download.cmd           ← 用包里的 exe 当 Node 跑 CLI（目标机器没装 Node 也能用）
  vgrab.cmd                 ← 同上，老名字留的入口
```

名字的约定：**中文名「肥鱼当劳」给人看**（窗口标题、界面品牌、桌面快捷方式、使用说明），
**英文名 `ds-download` 给机器看**（exe / 目录 / zip / 批处理 —— 纯 ASCII，任何代码页都不会乱码）。
老名字 `videograb` 只留在内部标识符里（`VIDEOGRAB_*` 环境变量、`vgrab` 命令别名），
改它们会把 QQ Agent 插件和既有脚本一起弄坏，所以**故意不动**。

几个要点：

- **exe 启动**：双击 `ds-download.exe` 就是完整应用，不需要 Node、不需要 npm。
  Windows 任务栏/通知的身份由 `app.setAppUserModelId` 固定，图标走包里的 `.ico`/`icon.png`；
- **工具种子**：包里带着 `yt-dlp.exe` / `ffmpeg.exe`，首次启动由 `main.js` 复制到
  `%APPDATA%\ds-download\tools`（安装目录一般只读，不能直接用）—— 这样离线也能立刻下视频。
  用 `--no-tools` 打包则不带，改成用时自动下载；
- **改名搬家**：老版本的设置/历史/登录态/工具都在 `%APPDATA%\videograb`，改名后 userData 变成
  `%APPDATA%\ds-download`，所以 `main.js` 里有一次**一次性迁移**（只在新目录里连 `settings.json`
  都没有时才搬，绝不覆盖新数据；纯 Chromium 缓存不搬）；
- **绝不打包**用户数据与依赖：`node_modules/`、`tools/history.json`、`tools/login-cookies.txt`
  都在排除清单里（打包脚本会**校验**，混进去就直接失败）；设置/历史/Cookie 都在 `%APPDATA%\ds-download`；
- **命令行进包**：`ds-download.cmd` 设 `ELECTRON_RUN_AS_NODE=1` 后用包里的 exe 跑 `src/cli.js`
  （脚本内容全程 ASCII，靠通配符找同目录的 exe，避免中文名在批处理编码里变成 `????.exe`）；
  另外 `findElectron()` 也认「当前进程自己就是 Electron」这一情形，所以内置浏览器兜底/登录窗口
  在打包版里照常可用；
- **打包脚本会自检**：关键文件齐全、没混进 node_modules/用户数据、zip 打得开；
  图标不存在会自动调 `build/make-icon.mjs` 生成。

### 换图标

图标有**三处**要看，一处不改就会露出"默认脸"：

| 位置 | 用哪份 | 谁负责 |
| --- | --- | --- |
| 窗口 / 任务栏 | `resources/app/icon.png` | `main.js` 的 `iconPath()` |
| 快捷方式 / 资源管理器里的 .ico | `ds-download.ico`（包根目录） | 打包脚本复制 `build/icon.ico` |
| **exe 文件自己**（PE 资源里的图标） | —— | **rcedit** 写进 `ds-download.exe` |

换成自己的图（源图路径会记到 `build/icon-source.txt`，那个文件是本地记录、不入库）：

```powershell
npm run icon:from -- "D:\某张图.jpg"     # 中心裁正方形 → 256 PNG + 多尺寸 ICO
npm run package -- --shortcut           # 重新打包（顺手更新桌面快捷方式）
```

- `npm run icon:from` 走 Electron 的 `nativeImage` 解码（jpg/webp/png 都吃），零额外依赖；
- **圆角**：图标与界面 logo 都会抠成**透明圆角**（半径 = 边长的 22%，3×3 子采样抗锯齿，
  见 `build/round-corners.cjs`）—— 直接二值裁会留锯齿，而合成到深色背景上时最明显。
  因为圆角已经写进 PNG/ICO 的 alpha 通道，界面里的 `.logo` **不要再加**底色或 `border-radius`
  （否则透明圆角外会透出一圈方底色），这条在 `styles.css` 里有注释；
- ICO 里写的是 **DIB 条目**（不是 PNG 压缩条目）—— 塞 PNG 时资源管理器能显示，但
  `System.Drawing.Icon`（很多脚本/老程序读图标的方式）会直接抛异常，所以统一用 DIB；
- `npm run icon` 是"没图时画一个默认图标"的兜底（会覆盖 `build/icon.png`，检测到已有源图时会先警告）；
- 不想让 rcedit 动 exe（比如没装它）：`npm run package:noicon` / `node build/build-package.mjs --no-rcedit`。

### 换界面左上角那个小头像（logo）

左上角是**界面里的图**，跟上面三处（窗口/快捷方式/exe）是两回事：

```powershell
npm run logo:from -- "D:\某张图.webp"   # 自动裁掉留白 → 正方形 → 192px → src/gui/renderer/logo.png
```

- 生成脚本 `build/make-logo.cjs` 会**自动裁掉四周的纯色留白**（原图常常一大片白边，
  直接缩到 40px 就小得看不清），再裁正方形、缩到 192（界面按 40px 显示，留够高 DPI 余量），
  最后**抠圆角**（跟应用图标同一套半径 0.22）；
- 源图路径会记在 `build/logo-source.txt`（本地记录，不入库）；仓库里自带的 `src/gui/renderer/logo.png`
  已经生成好了，不想换图就不用管它；
- 圆角是**抠进 PNG 的 alpha 通道**里的，所以 `styles.css` 里 `.logo` **不要**再加底色或 `border-radius`
  （否则透明圆角外侧会透出一圈方底色）；
- 自检会检查它**真的加载出来**（`naturalWidth > 0`），图丢了/路径错了 `npm run selftest` 会直接红。

## 组件说明

- **yt-dlp**：站点解析引擎。首次遇到需要它的链接时自动下载到 `tools/yt-dlp.exe`（也可 `vgrab --update-ytdlp` 手动更新）。也可以自己放到 `PATH` 里，程序会优先使用已存在的。
- **ffmpeg**：用于把 TS 分片无损转封装成 MP4、合并 DASH/HLS 的分离音视频轨、把仅音频模式转成 mp3。B 站等站点的清晰度基本都是「画面」和「声音」分开的，所以**第一次遇到这类链接时程序会自动获取 ffmpeg**（约 30MB，仅一次；界面里可取消勾选「需要合并音视频时自动获取 ffmpeg」，命令行用 `--no-auto-ffmpeg`）。也可以提前手动执行 `vgrab --fetch-ffmpeg`，或把系统里已有的 ffmpeg 放进 `PATH`。
- **内置浏览器**：应用自带 Chromium（Electron）。当 yt-dlp 解析不了某个链接时（典型是抖音：它要求 JS 生成的签名，yt-dlp 目前还没实现），程序会自动用它**渲染页面**、监听播放器发出的请求，抓到真正的视频/音轨地址再下载并合并。这个兜底默认开启，可用界面上的勾选或命令行 `--no-browser-assist` 关闭。

## 文件与命名

- 输出文件名取自网页标题 / `Content-Disposition` / 链接路径，自动做 Windows 非法字符清洗。
- 默认不覆盖同名文件，会自动变成 `名字 (1).mp4`；加 `--overwrite` 可覆盖。
- 下载中的临时文件是 `xxx.part`（HLS 另有 `xxx.part.json` 记录已完成分片），中断后重新执行同一命令即可续传。

## 测试

```powershell
npm test          # 离线测试：37 项，含加密 HLS、断点续传、直播录制/随时结束/直播识别、FLV 连续流、登录与 Cookie 导出、下载历史、分享文案提取链接、图片帖（识别/去重/小图过滤/正文区域选取/Pixiv 全流程）、产出文件判定、网络错误与站点分流、选流编码、浏览器兜底、编排层、CLI
npm run test:net  # 真实网络冒烟测试（会下载示例视频并自动获取 yt-dlp）
npm run test:pages # 用内置浏览器跑「图文帖轮播逐张翻页」「懒加载长图集滚动收集」两项抽取测试（需要 Electron，本地测试页，不依赖外网）
```

离线测试自带一个模拟视频服务器（支持 Range、AES-128 加密分片、fMP4、内嵌视频网页、逐步增长的直播列表），不依赖外网。

## 常见问题

**抖音链接报 “Fresh cookies (not necessarily logged in) are needed”？** 那是 yt-dlp 的抖音提取器还没实现抖音的签名（源码里是 TODO），加 Cookie 也解决不了。本版本遇到这种情况会**自动改用内置浏览器渲染页面并抓取播放器请求的真实地址**，把画面和声音分别下载后合并成完整 MP4，真实标题也会作为文件名。这条兜底对其它强反爬站点同样有效。

**配置了代理，浏览器能打开 pixiv，但工具连不上？** 这是早期版本的老毛病，现在修好了。原因是「内置下载引擎」用的是 Node 自带的 HTTP 客户端，它**既不看 Windows 系统代理，也不看界面里填的代理地址**——只有把代理写成环境变量、还得在启动时加 `NODE_USE_ENV_PROXY=1` 才认，于是出现「浏览器（走系统代理）能开 pixiv，工具却连不上」的割裂。现在：

- **界面**：什么都不用填，工具会**自动读取 Windows 系统代理**（Clash / v2rayN / 系统设置里的那个），跟浏览器保持一致 —— 浏览器能打开的站点，工具就能打开；也可以在「下载选项 → 代理地址」里显式指定（优先级更高）。
- **命令行**：`--proxy http://127.0.0.1:7897` > 环境变量 `HTTPS_PROXY` > Windows 系统代理，按这个顺序自动选用，`vgrab --doctor` 会告诉你当前用的是哪个。
- 代理只支持 **HTTP 代理**（Clash/V2Ray 的 HTTP 端口，一般和 SOCKS 端口混用同一个口）；填 `socks5://...` 会提示改用 HTTP 端口。
- 请求头（`Referer`、`Cookie`、`Range`）是原样透传的 —— pixiv 图片没有 `Referer` 会直接 403，这一点很关键。

**怎么确认代理到底通不通？** 界面「下载选项 → 代理地址」旁边有 **「测试代理」** 按钮，命令行用 `vgrab --check-proxy`。它会对几个代表性站点**各测两次**（一次直连、一次经代理），然后给出一句明确结论，例如：

```
  ✓ [经代理] 国内站点     200   1593ms  国内站点 连接正常（HTTP 200）
  ✗ [直连  ] pixiv         -   7004ms  连接超时：请求超时（7000ms）
  ✓ [经代理] pixiv        200    503ms  pixiv 连接正常（HTTP 200）

✔ 代理可用（http://127.0.0.1:7897），已让 2 个直连失败的站点变得可访问
```

代理写错时会直接告诉你「代理不生效：连接被拒绝（ECONNREFUSED）……检查代理软件是否在运行、地址端口是否写对」，不用等下载失败才发现。注意 pixiv / YouTube 经代理后返回 `403` 也算**连上了**（是站点自己的防火墙按指纹拦 Node 请求），自检会标注出来——这类站点下载时会改用内置浏览器请求。

**改了代理要重启程序吗？** 不用。界面里改完点「测试代理」（或直接点别处触发保存），代理会**立即**应用到内置浏览器、yt-dlp 与内置下载引擎；自检通过后该地址会被保存下来，下次启动继续用。命令行每次运行都是新进程，本来就即时生效。

pixiv 的 R-18 / 需登录作品还要先「登录」（内置浏览器登录 pixiv，登录态会一起用于图片下载）。

**pixiv 报 “连接被重置（ECONNRESET）” 或 403？** 这是 Cloudflare 按 **TLS 指纹**挡住了命令行式请求（响应头里能看到 `server: cloudflare`，比如 553 字节的 `403 Forbidden` 页面）——不是你的代理或 Cookie 有问题，换请求头也没用。现在的版本改成**用内置浏览器请求 pixiv 接口**（真实 Chromium 指纹，顺带带上登录态和你的代理），图片再从 `i.pximg.net` 正常下载，已经实测能下整组原图。如果仍然失败，请确认：代理可用（`vgrab --doctor` 看当前用的代理）、以及 pixiv 是否需要登录。

**下载 B 站专栏 / 图文页时，混进了头像、图标等无关图片？** 老版本是把页面里所有 `<img>` 一起抓，于是头像（`i0.hdslb.com/bfs/face/...`）、用户装扮（`bfs/garb`）、图标字体与前端资源（`bfs/svg-next`、`jinkela`、`*.js/*.css`）、以及正文图的 80w/128w 缩略变体全被存了下来。现在的规则是：

1. **只认正文来源**：B 站专栏只保留 `i0.hdslb.com/bfs/article/` 下的图片（头像、装扮、UI 资源、前端文件直接排除）；抖音图文走轮播逐张翻页；其它站点优先正文区域。
2. **同一张图只留最清晰的变体**：B 站的 `@1192w` 与 `@128w_128h_1c`、抖音的 `~tplv-…:1080:1440` 都会归并成一张。
3. **按体积兜底**：下载前先探一次大小，小于 20 KB 的一律丢掉（表情、缩略图、图标）。

以某篇专栏实测：修复前会存下 31 个文件（多为 1~3 KB 的缩略图/头像），修复后只保留 4 张正文图。

**图很多的长图文（如 B 站 opus 图集）只存了 80 张？** 老版本给图片数量留了 80 张的硬上限，现在已经**取消**：正文来源与体积两道过滤已经把干扰项挡掉了，有多少有效图就存多少。另外长文章的图片是**懒加载**的——不滚到位置根本不会出现在页面里，所以程序现在会**先滚动整页**（自动往下滚、等页面不再长高为止，最多 20 秒）再收集，并会真正加载图片。本地 130 张的懒加载图集实测能全部收到（含去重与干扰项过滤）。

**提示「页面被站点拦截了……风控要求人机验证」？** B 站/抖音这类站点会对短时间内的高频自动访问弹人机验证（返回一个验证码页面）。程序现在能识别这种页面并直接告诉你，而不是把验证码图片当成正文图存下来。处理办法：稍等一会儿再试，或先用界面右上角的「登录」在内置浏览器里打开该站点、手动过掉验证后再下载（登录态与验证结果都会保存在内置浏览器里）。

**任务显示「完成」但目录里什么都没有？** 早期版本在下图全失败时也会报成功。现在只要一张都没下下来就会**判为失败**并告诉你原因（例如 `返回的不是图片（application/json）`），不会再出现"显示成功、目录却空着"的情况。

**下载 B 站 1080P 报 “Requested format is not available”？** 这是 B 站的清晰度都是音视频分离的、而本机还没有 ffmpeg 导致的。现在的版本会在遇到这个错误时**自动获取 ffmpeg（约 30MB）并自动重试**，无需手动处理；关掉了自动获取的话，执行 `vgrab --fetch-ffmpeg` 即可。

**抖音图文 / Pixiv 这类「图片帖」怎么下？** 直接把链接丢进来就行，程序识别到是图片帖会改下图片（不走视频引擎）：

- **Pixiv 插画**：`https://www.pixiv.net/artworks/12345678`，取每一页的**原图**。pixiv 前面挂着 Cloudflare，会按 TLS 指纹把 Node 的请求一律 403（`server: cloudflare`，换任何请求头都没用），所以接口是**用内置浏览器**（真实 Chromium 指纹 + 登录态 + 你的代理）去请求的，图片再从 CDN 流式下载。R-18 等需要登录的作品请先用「登录」功能登录 pixiv。首次解析会拉起内置浏览器，约 20~30 秒。
- **抖音图文**：`https://www.douyin.com/note/7693365550072861451`、手机分享页 `iesdouyin.com/share/note/...`，或者直接把 App 里「复制链接」得到的**整段分享文案**粘进来（`v.douyin.com/xxx` 短链会先跟随跳转判断是图文还是视频，是图文就自动按图片下载）。程序用内置浏览器打开页面后**逐张翻轮播**收集这篇帖子自己的图（拿到的是 3000px 的高清地址）。页面里同时挂着推荐流、评论区配图和私信头像，程序按「轮播翻页 → 正文区域 → 图片地址特征」的顺序判断，不会把别人的作品当成这篇帖子的图；同一张图的多个尺寸变体也只留最清晰的一个。

多图会存进以帖子标题命名的子目录，按 `001.jpg`、`002.jpg` 编号；只有一张图时直接存成单个文件（例如 `回应我的心意吧，mega进化.jpg`）。抖音图文从开始到出图约 30~50 秒（等页面渲染 + 翻页）。

**想下 1080P+ / 4K / 大会员内容？** 需要登录。推荐用内置登录：界面点右上角「登录」（命令行 `vgrab --login bilibili`），在弹出的窗口里扫码登录，关掉窗口即完成，之后下载会自动带上登录状态（保存在 `tools/login-cookies.txt`）。它用的是应用自带的 Chromium，**不读取你日常浏览器的 Cookie 数据**；登录状态也会持久保留，下次开箱即用。

如果你更喜欢用浏览器的登录态，也可以 `--cookies-from-browser chrome`（或 Edge/Firefox）。注意：浏览器正在运行时它的 Cookie 库被独占锁定，yt-dlp 可能读不到，需要先关掉浏览器 —— 这正是内置登录更方便的原因。

**YouTube 报 “fetch failed” / 打不开？** 早先版本会先自己去请求一次链接做预探测，而国内直连 `www.youtube.com` 常被重置，于是只报出一句没头没尾的 `fetch failed`（其实 yt-dlp 本身能下）。现在两点都改好了：

- **YouTube / Twitter / Instagram / B站 / 抖音 这类站点直接交给 yt-dlp 解析**（跳过没意义的预探测），不再被直连失败挡住；
- 网络错误会翻译成能看懂的中文提示（连接被重置 / 域名解析失败 / 连接被拒绝 / 超时），并提示配代理。

确实需要代理时：`vgrab "链接" --proxy http://127.0.0.1:7897`（同时作用于 yt-dlp、内置浏览器与内置下载引擎），或在界面「下载选项 → 代理地址」里填写。**什么都不填也没关系**：工具会自动跟随 Windows 系统代理（Clash/v2rayN 设的那个），浏览器能打开的站点这里也能打开。

**下载完了，但记录显示失败？** 早先版本会遇到：yt-dlp 其实已经下完文件，只是**收尾步骤**（写元数据、缩略图、转封装等）报错，于是以非 0 退出，被我们当成失败 —— 就出现「下载目录里有文件、下载记录却是失败」。现在改成：**只要文件确实产出了就按成功处理**，并在日志里注明原因：

```
ⓘ yt-dlp 报了错，但文件已经下载完成，按成功处理：Postprocessing: Command returned error code 3
```

另外如果 yt-dlp 报告的路径和实际落盘的路径不一致（重命名/临时路径等），会自动改用下载目录里刚产出的那个文件，不再误报失败。

**提示需要登录 / 解析失败？** 用 `--cookies-from-browser chrome`（或 Edge/Firefox）或 `--cookies cookies.txt`。GUI 里在「下载选项」中同样可以设置。

**下载很慢？** 提高 HLS 分片并发 `-c 16`；站点视频可用 `--parallel` 同时下多个任务。国内访问部分站点建议配 `--proxy http://127.0.0.1:7890`。

**m3u8 是直播流？** 程序会识别出「没有 EXT-X-ENDLIST」。默认只保存当前已发布的分片并给出提示；勾选界面上的「直播流持续录制」（或命令行 `--live`）后会持续录制，**并可以随时结束**：

- 命令行：按一次 **Ctrl+C** → 立刻收尾并把已录制的部分保存成可播放文件（再按一次才强制退出）；
- 图形界面：任务卡片上的按钮会变成 **「结束录制」**，点一下即可，结束后会显示已保存的时长；
- 也可用 `--live-seconds 300` 让它录到指定秒数自动结束。

**直播间页面**（如 `live.bilibili.com/123`、`live.douyin.com/123`）同样支持随时结束：程序用 yt-dlp 判断是不是直播，是的话改为内置录制引擎直接拉流（B 站直播走 HLS；抖音直播 yt-dlp 不支持，改用内置浏览器抓到的 FLV 流），结束时自动转封装成 MP4 并归一化时间轴（否则直播的绝对时间轴会让时长显示成几小时）。抖音直播从开始到出画面约 30~50 秒，大部分时间花在等待页面渲染与抓流。

录制从当前播放列表里的分片开始（包含直播窗口里已缓冲的那部分）。有 ffmpeg 时，结束录制后会自动把 TS/FLV 转封装成 MP4；没有 ffmpeg 则保留 `.ts` / `.flv`（同样可播放）。

**每次都要输入完整路径太麻烦？** 把项目目录加入 PATH，或直接用 `启动界面.cmd` 图形界面。

**想把界面打包成独立 exe？** 安装 electron-builder 后执行 `npx electron-builder --win portable`（本项目未内置打包配置，可按需添加）。

## 免责声明

本工具仅用于下载你有权存取的内容，例如自有素材、公开许可视频或已获授权的内容。请遵守目标网站的服务条款与当地法律，不要用于侵犯版权或规避付费墙。

### 抖音为什么会跳人机验证

2026-10 起抖音上了 **ArgusSecurityPlugin**，把「直接调接口」这条老路封了：

| 尝试 | 结果（本机实测 2026-10-24） |
| --- | --- |
| `aweme/v1/web/aweme/detail/` + `ttwid` | 403 `Blocked by ArgusSecurityPlugin Uifid Not Found` |
| 同上，走代理 / 换移动 UA / 移动站 `m.douyin.com` | 全部 403 |
| `iesdouyin` 分享页 `_ROUTER_DATA` | 只剩空壳（约 32KB，没有 `videoInfoRes`） |
| `web/api/v2/aweme/iteminfo/`、`aweme.snssdk.com` 老接口 | 空响应 |

Argus 要的是 `uifid`（浏览器指纹）+ `msToken` + `a_bogus`（JS 签名），都是浏览器现场生成的，
HTTP 层拿不到。所以现在**只能走浏览器通道**：

- 工具用内置 Chromium 打开页面，监听播放器发出的视频请求；
- 页面若是「验证码中间页」，会在 **2~7 秒内**识别并直接告诉你怎么办（不再白等 40~90 秒）；
- 提高成功率：**完全退出 Edge 再发链接**（工具会自动导出你 Edge 里的新登录态；
  Edge 运行时它的 cookie 库被独占，导不出来），或在桌面版里手动过一次验证。

> 想让工具直接驱动你**平时在用的浏览器**（成功率最高）：用调试端口启动它，例如
> `start msedge --remote-debugging-port=9222`，然后保持登录。这条通道还没接进工具，
> 需要的话可以加。

# 发布到 GitHub（方案 A：源码进仓库 + 分发包走 Release）

> 结论先说：**仓库里只放源码**（约 1.5 MB），**几百 MB 的成品走 Release 附件**。
> 原因：`ds-download.exe` 单体 200 MB，超过 GitHub 单文件硬上限 100 MB，普通 git 直接拒收；
> 而 Release 单个附件上限是 2 GB，175 MB 的 zip 完全没问题。

---

## 0. 本机还缺 git

这台机器上 `git` 不在 PATH。装一个（任选其一）：

```powershell
# 方式一：winget
winget install --id Git.Git -e --source winget

# 方式二：手动下 https://git-scm.com/download/win 装完重开终端
# 方式三：装 GitHub Desktop（图形界面，自带 git）
```

装完确认：

```powershell
git --version
git config --global user.name  "你的名字"
git config --global user.email "你的邮箱@example.com"
```

---

## 1. 仓库目录已经准备好了

源码已经在这个目录里（`node_modules/`、`dist/`、`tools/*.exe` 都已排除）：

```
D:\ds-download\
  ├─ src\                 应用代码（CLI + 引擎 + Electron 界面）
  ├─ build\               打包/图标脚本（icon.png、icon.ico 也在）
  ├─ tests\               离线测试（node tests/run.js，45 项）
  ├─ qqagent-plugin\      QQ Agent 插件源码 + 内置工具脚本
  ├─ package.json         开发用清单（含 scripts 与 devDependencies）
  ├─ package-lock.json
  ├─ README.md
  ├─ LICENSE              MIT（**记得把版权人改成你自己**）
  ├─ .gitignore
  ├─ vgrab.cmd            命令行包装脚本
  └─ 启动界面.cmd          双击开界面（开发方式）
```

已做的清理：

- 删掉了 `build/icon-source.txt`、`build/logo-source.txt`（里面是本机图片路径）；
- `README.md` 里的个人路径改成了通用说法；
- `src/gui/main.js` 里自检用的演示数据（原来写着你的真实视频名和下载目录）换成了示例；
- `.gitignore` 已排除 `node_modules/`、`dist/`、`tools/`、Cookie、历史、编辑器杂项。

提交前自检（不装 git 也能跑）：

```powershell
cd D:\ds-download
# 看一眼体积分布，确认没有大文件混进来
Get-ChildItem -Recurse -File | Sort-Object Length -Descending |
  Select-Object -First 10 @{n='文件';e={$_.FullName}}, @{n='MB';e={[math]::Round($_.Length/1MB,2)}}
```

---

## 2. 本地提交

```powershell
cd D:\ds-download
git init
git add .
git status                # ★ 必须看一眼：列表里不该出现 node_modules/ dist/ tools/*.exe
git commit -m "肥鱼当劳（ds-download）v1.0.0：本地视频下载工具（cli + Electron 界面）"
git branch -M main
```

---

## 3. 在 GitHub 上建空仓库

网页 → **New repository** → 名字填 `ds-download` →
**不要**勾 "Add a README / .gitignore / license"（本地已经有了，勾了会冲突）→ Create。

---

## 4. 推送

```powershell
git remote add origin https://github.com/<你的用户名>/ds-download.git
git push -u origin main
```

**认证**（GitHub 早已不收账号密码）：

- **HTTPS + PAT**：GitHub → Settings → Developer settings → Personal access tokens →
  Fine-grained tokens → 只给这个仓库 `Contents: Read and write` → 生成后当密码用
  （用户名填 GitHub 用户名，密码处贴 token）。
- **SSH**：`ssh-keygen -t ed25519 -C "邮箱"` → 把 `~/.ssh/id_ed25519.pub` 贴到
  GitHub → Settings → SSH keys → remote 改成 `git@github.com:<用户名>/ds-download.git`。

---

## 5. 分发包作为 Release 附件

成品 zip 由 `D:\ds-download-1.0.0-win-x64\` 这个目录打包而来（脚本见下），
**不要**放进仓库：

```powershell
# 在任意目录执行（-C 指定父目录，zip 里只会有一层文件夹）
tar -a -c -f "D:\ds-download-1.0.0-win-x64.zip" -C "D:\" "ds-download-1.0.0-win-x64"
```

然后：仓库页右侧 **Releases** → **Draft a new release** → Tag 填 `v1.0.0` →
把上面那个 zip 拖进 "Attach binaries" → **Publish release**。

附件单个上限 2 GB，175 MB 的 zip 没问题；而且它不进 git 历史，别人 clone 依旧只有 1.5 MB。

---

## 6. 以后每次发版

```powershell
cd D:\ds-download
git add -A
git commit -m "fix: …"
git push

# 改完代码重新出包（在开发目录里）
npm install            # 只有第一次 / 换机器时需要
npm run package -- --shortcut
tar -a -c -f "D:\ds-download-1.0.1-win-x64.zip" -C "D:\" "ds-download-1.0.0-win-x64"   # 名字按版本改
```

> 想升版本号：改 `package.json` 的 `version`，重新 `npm run package`，产物目录/zip 名会跟着变。

---

## 7. 上传前最后三道关

1. **别提交用户数据**：`tools/login-cookies.txt`（等于你的账号登录凭据）、`tools/history.json`。
   仓库里现在没有，但你在开发目录里跑过工具后会有 —— `.gitignore` 已挡住，`git status` 再确认一次。
2. **LICENSE 改版权人**：现在写的是 `<把你的名字/ID 填在这里>`。
3. **README 里的个人路径**：已经清过；以后新增文档别把自己电脑的绝对路径抄进去。

---

## 附：为什么不把成品塞进仓库（备查）

| 方案 | 可行性 | 代价 |
| --- | --- | --- |
| 普通 git 提交 200 MB 的 exe | ❌ GitHub 单文件上限 **100 MB**，直接拒收 | —— |
| Git LFS 存成品 | ✅ 可以 | 免费额度 **1 GB 存储 + 1 GB/月流量**，这份 421 MB 会吃掉近一半；别人 clone 也要拉 421 MB |
| **Release 附件（推荐）** | ✅ 单附件 2 GB | 仓库只有源码，clone 极快；下载成品点一下即可 |

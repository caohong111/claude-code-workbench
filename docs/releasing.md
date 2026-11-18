# 维护者发布步骤

这些命令会创建公开仓库并上传代码，只应在完成本地审查后由维护者执行。不要在个人 Claude 安装根目录或运行数据目录初始化 Git。下面的 `D:\Projects\claude-code-workbench` 代表独立、已脱敏的公开源码目录。

## 1. 审查公开内容

确认仓库只包含项目源码、通用默认素材、测试、文档及构建脚本。不要上传 `.claude`、`.codex`、CC Switch 数据库、API 配置、聊天历史、截图、个人头像、缓存、依赖目录或本地安装目录。

检查 `.gitignore` 和构建配置的文件白名单，并阅读 `tools/audit-release.mjs` 的检查范围。自动扫描主要检查项目自己的候选文件及常见密钥格式；依赖文件和图像隐私仍需单独审查。扫描通过不等于保证绝无秘密。

## 2. 本地构建与安装包检查

在 Windows x64、Node.js 22.12.0 或更新版本以及 Git for Windows 环境中执行：

```powershell
Set-Location 'D:\Projects\claude-code-workbench'
npm ci
npm run runtime:install
npm run audit:release
npm test
npm run build
npm run test:desktop
npm run test:direct
npm run test:media
npm run test:themes
npm run pack:win
node tools/audit-release.mjs --artifact .\release\win-unpacked
npm run dist:win
node tools/audit-release.mjs --artifact .\release\win-unpacked
npm run test:package
```

第一条制品检查会扫描解包应用的 `resources/app.asar` 及额外资源，第二次确认最终打包阶段仍未混入本机数据。发布文件只应从 `release` 中挑选构建产物，不要把整个开发目录压缩上传。

`npm ci` 的项目安装步骤默认运行 `tools/ensure-runtime.mjs`，调用 Electron 自带安装器并验证其可执行文件；上面的显式 `runtime:install` 也适用于 npm 本机设置跳过安装脚本的环境。该流程下载的是 Electron 桌面运行时，不会请求 Claude/API 模型，也不需要生产密钥。打包前必须确认运行时准备成功。

从 `release\win-unpacked` 打开应用，使用隔离的数据目录检查启动、主题和项目选择。安装程序还应在独立 Windows 用户或测试机器上检查安装、快捷方式、启动与卸载；保留项目文件及 Claude 原生配置。没有执行的验证应写为未验证。

当前工作流生成的是**未进行数字签名**的安装程序，不包含维护者的签名证书。可在本地检查：

```powershell
Get-ChildItem .\release\*Setup*.exe | Get-AuthenticodeSignature
Get-ChildItem .\release\*Setup*.exe | Get-FileHash -Algorithm SHA256
```

发布前确认未签名状态及 SHA256 值，并在发布说明中保留这一事实。SHA256 用于比对文件，不代替发布者签名；不要指导用户关闭 Windows 安全功能。未来接入代码签名时，证书及密码只能放在受保护的 CI Secrets 或本地安全存储，不能写入仓库。

## 3. 创建公开 GitHub 仓库

先确认 `gh auth status` 对应你准备发布的 GitHub 账户。账户登录由维护者自己完成，不要把令牌放到聊天、脚本或 Git remote URL 中。

```powershell
git init -b main
git add .
git diff --cached --name-only
git diff --cached --stat
npm run audit:release
```

审查暂存文件清单和源码差异，确认不存在个人配置、未知二进制素材或凭据。然后执行：

```powershell
git commit -m "Initial public release"
gh repo create caohong111/claude-code-workbench --public --source . --remote origin --push
```

上述 `gh repo create` 会立即公开并上传当前 Git 历史。若仓库已经存在，先检查 `git remote -v`、目标仓库及访问权限，再设置正确的 `origin` 和推送，不要覆盖其他仓库。如果历史中曾提交过密钥，只删除当前文件不足以修复历史泄露，必须先撤销或轮换密钥并处理历史，再考虑公开。

## 4. 发布 v0.1.0

确认 `package.json` 和锁文件中的项目版本为 `0.1.0`，所有改动已经提交，GitHub 的常规 CI 通过。当前 `release.yml` 监听 `v*` 标签：

```powershell
git tag -a v0.1.0 -m "v0.1.0"
git push origin v0.1.0
```

该标签会触发 Windows 构建、测试、内容检查、安装包生成和 SHA256 文件生成，并创建带以下附件的 GitHub Release：

- `Claude-Code-Workbench-Setup-0.1.0-x64.exe`：普通用户运行的 Windows 安装程序。
- `SHA256SUMS.txt`：安装程序校验值。

手动运行发布工作流只生成 Actions 构建附件；只有标签触发才执行发布 Release 的步骤。发布完成后，检查工作流状态、Release 附件与校验值，并从 Release 下载一次安装包核对哈希。

GitHub 自动提供的 **Source code (zip/tar.gz)** 仅包含仓库源码，不能双击安装。想要普通桌面安装体验的用户应下载 `.exe`；想用 Codex 安装源码的用户应阅读 [安装提示词](install-with-codex.md)。

后续版本先更新项目版本与锁文件，完成相同检查，再创建新的版本标签。不要移动已经发布的标签或用不同内容覆盖相同版本安装包。

## 许可证与第三方资源

MIT 只覆盖维护者有权授权的项目代码与原创默认素材。官方 Claude Agent SDK、其运行组件、Electron 和其他依赖适用各自的许可证或服务条款，不会因为本仓库采用 MIT 而改变。保留 `THIRD_PARTY_NOTICES.md`、打包时收集的许可证与依赖声明；不要把本项目描述为 Anthropic 官方产品，也不要附带作者的账户或 API 额度。

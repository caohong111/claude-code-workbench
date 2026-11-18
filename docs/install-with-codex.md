# 让 Codex 帮你安装

下方提示词使用计划发布的公开仓库地址；仓库实际公开后，再把完整提示词交给 Codex。提示词不需要包含任何 API 密钥。

## 可直接使用的提示词

```text
请帮我安装这个 Windows 桌面应用：
https://github.com/caohong111/claude-code-workbench

先阅读仓库 README、install.ps1 和安全说明，确认是这个项目。优先使用仓库 Releases 中的 Windows 安装包；如果还没有安装包，则下载源码 ZIP 或使用 Git 克隆，按照 README 在我选择的目录进行源码安装。

请先检查现有安装，不要覆盖我的其他文件、Claude 配置或聊天历史。需要选择目录时，使用一个新的独立文件夹。源码方式要求 Node.js 22.12.0 或更新版本：已有合适版本就复用，没有则说明官方 Node.js LTS 的安装步骤，不要执行不明来源的远程脚本。

源码安装使用仓库的 install.ps1。它会运行 npm ci、npm run runtime:install 和构建流程。请确认 Electron 官方运行时已经准备好；如果 npm 的全局设置跳过了安装脚本，不要只看到 node_modules 就认定安装完成。运行时下载失败时先解决对应的网络问题，不要向我要 API 密钥。

Claude 在 Windows 上需要 Git Bash，请检查 Git for Windows 是否存在；缺少时说明官方安装步骤，不要静默安装系统依赖。工作台可使用所带的官方 SDK 运行组件，不必强制全局安装 Claude CLI。

安装完成后创建或确认工作台入口，打开应用，检查能否选择项目文件夹、加载主题和读取已有的 Claude 配置。不要为了验证而调用付费模型；真实聊天和生图由我之后测试。

我会使用自己的 Claude 账户、API 或 CC Switch 配置。不要让我把密钥发到聊天中，不要把密钥写入源码、日志、测试、提交或公开文件；不要复制项目作者的凭据。若已有 CC Switch 配置，请使用其 Claude 配置目录，并保留原配置。

最后告诉我安装位置、数据位置、如何打开、如何连接自己的渠道，以及尚未完成的步骤。不要声称尚未执行的验证已经通过。
```

## 手动源码安装

下载并解压 ZIP 后，在源码目录运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -InstallDir 'D:\Apps\ClaudeWorkbench' -DataDir 'D:\Apps\ClaudeWorkbenchData'
```

安装器只接收本地目录参数，不需要密钥。使用 `-InstallDir` 时目标目录必须为空；不传此参数会直接在当前源码目录安装。安装器不会修改 `CLAUDE_CONFIG_DIR` 或 `~/.claude`。

完成后打开桌面上的 **Claude Code Workbench (Source)**。如果没有创建快捷方式，可双击源码目录的 `launch.vbs`；自定义 `DataDir` 时应继续使用安装器创建的快捷方式，以保留同一个数据位置。

## 安装不包含账户

工作台是可视化客户端，API 和 Claude 登录属于使用者自己的配置。已有 CC Switch 时，确认它修改的是哪个 Claude 配置目录；没有配置时，请按官方说明配置自己的账户。不要从陌生人的配置包导入密钥。

图片生成功能取决于当前渠道是否提供 `image_generation` 工具及权限。可以安装成功但暂未具备生图权限，这时应调整自己的渠道配置，而不是反复发送付费请求。

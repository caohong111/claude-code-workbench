# Claude Code Workbench

Claude Code CLI 的 Windows 可视化桌面工作台。打开项目文件夹，通过聊天、按钮和设置页面处理代码与文件，查看工具记录，并在需要时确认修改。

这是社区项目，不是 Anthropic 官方客户端，也不附带账户、API 密钥或免费额度。使用者需要自己的 Claude 登录或 API 配置；不同渠道可用的模型和功能可能不同。

## 功能

- 工作区、多个对话、文件浏览、修改对比和工具操作记录。
- 中断后保留已显示回复，可在同一对话点击“继续任务”；不会自动重发失败请求。
- 常用 Claude Code 命令的分类菜单及配置表单；尚未支持的原生功能会标明不可用。
- 读取 Claude 配置，跟随 CC Switch 切换渠道，获取模型列表。
- 截图粘贴、图片附件、聊天中的本地图片和 SVG 原文件预览、下载。
- Responses 对话中，历史截图累计超过 40 MiB 后仍可续聊。本轮优先发送新图和最近的截图，未随请求发送的旧图仍保留在聊天中；需要核对旧图细节时可重新附上。
- 支持渠道上的 Responses 图片生成工具；实际可用性、尺寸与计费由渠道决定。
- 16 套主题，可更换应用图标和聊天头像。
- 回车发送，Ctrl + 回车换行；支持中文输入法。

Claude 模型使用官方 Claude Agent SDK；兼容的 GPT 代码对话通过配置渠道的 Responses API 执行，不需要启动 Codex。命令能力边界见 [官方命令核对记录](docs/official-command-audit.md)。

Responses 对话会发现 Claude 用户及项目中的本地技能，以及已安装、启用且作用域匹配的插件技能，按需读取技能和辅助文件。插件 MCP、Hook、动态命令注入和原生子代理仍需 Claude 原生模型路径；工作台不会将读取技能说明当作已执行这些能力。

## 安装方式一：Windows 安装包

在仓库的 [Releases](https://github.com/caohong111/claude-code-workbench/releases) 中下载 Windows 安装程序，运行后选择安装位置。安装完成后，从桌面或开始菜单打开工作台。安装包不要求事先安装 Node.js；Claude 在 Windows 上的命令执行需要 [Git for Windows](https://git-scm.com/downloads/win) 中的 Git Bash。

只有发布了带安装程序的 Release，此入口才可用。仓库源码 ZIP 不等于安装程序。未进行代码签名的社区安装包可能触发 Windows 的发布者提示；请先核对 Release 校验值与来源，不要关闭系统安全功能。

首次使用仍需完成下方的个人账户或渠道配置。应用安装与 API 服务订阅是两件独立的事。

## 安装方式二：源码或 Codex

要求：Windows 10/11 x64、[Node.js LTS](https://nodejs.org/) 22.12.0 或更新版本，以及可访问 npm 和 Electron 官方运行时下载服务。Claude Code 的 Windows 命令执行还需要 [Git for Windows](https://git-scm.com/downloads/win)（包含 Git Bash）；兼容 Responses 渠道可独立使用。可以下载源码 ZIP 并解压，不必使用 Git 克隆。

在源码文件夹打开 PowerShell：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

这只为当前安装命令指定脚本执行方式，不修改系统的执行策略。脚本会检查 Node.js，提示缺少的 Git Bash，安装锁定依赖、确认 Electron 运行时、构建应用，并创建桌面和开始菜单快捷方式。它不会安装或填写任何 API 密钥，也不会静默安装系统依赖。

`npm ci` 的项目安装步骤会运行 `tools/ensure-runtime.mjs`，通过 Electron 自带安装器准备桌面运行时，并检查实际可执行文件。源码安装器还会显式执行 `npm run runtime:install`，避免 npm 全局设置跳过安装脚本后出现“依赖已装好但 Electron 不存在”。下载缓存使用所选数据目录；没有指定缓存环境变量时使用 `local-data/cache/electron`。

将源码安装到另一个空文件夹，并把运行数据也放在指定位置：

```powershell
.\install.ps1 -InstallDir 'D:\Apps\ClaudeWorkbench' -DataDir 'D:\Apps\ClaudeWorkbenchData'
```

默认在当前源码目录安装，运行数据保存在 `local-data`。支持 `-NoLaunch` 仅安装、`-SkipShortcuts` 不创建快捷方式。安装目标已有文件时不会覆盖；更新源码请保留本地数据并按下方更新步骤操作。

给 Codex 使用的完整安装提示词见 [让 Codex 帮你安装](docs/install-with-codex.md)。不要把 API 密钥粘贴进提示词。

## 首次连接

1. 如果已经使用 CC Switch 或 Claude Code，工作台默认读取 `CLAUDE_CONFIG_DIR` 指定的目录；未指定时读取当前用户的 `~/.claude`。
2. 在 CC Switch 中配置使用者自己的 Claude 渠道，或按 [Claude Code 官方设置说明](https://code.claude.com/docs/zh-CN/setup) 安装、登录官方 CLI。不要使用项目作者的账户或凭据。
3. 打开工作台，点击“打开文件夹”，选择项目。在输入框下方选择模型，再发送任务。
4. 渠道需要支持 Anthropic Messages 或相应的 Responses 协议。模型列表接口、图片生成与官方账户功能并非所有渠道都提供。

若你的 CC Switch 使用自定义 Claude 配置目录，请先为工作台进程设置 `CLAUDE_CONFIG_DIR`。该目录不会因为安装本项目而自动复制或覆盖。

“手动确认”是默认权限。文件修改和命令执行是否需要确认，以当前模式及工具限制为准。计划模式不能生成图片。图片按钮“AI 生图”使用当前渠道支持的图片工具，生成文件写入项目的 `generated-images` 文件夹。

“自动接受编辑”会跳过工作区文件编辑确认，执行命令仍需确认。Responses 模式优先使用内置文件读写工具；“自动判断”在该模式下同样保留命令确认。

## 本地数据与隐私

程序源码不包含生产配置、聊天历史、截图、个人头像或凭据。每个使用者的连接配置、工作区及历史都留在自己的电脑上。

- 安装包的应用数据使用当前用户可写目录；可通过 `CLAUDE_WORKBENCH_HOME` 指定其他位置。
- 源码安装器的快捷方式使用所选的 `DataDir`，默认是源码目录内的 `local-data`，其中包含历史、附件、缓存和临时文件。
- Claude 原生配置使用独立的 `CLAUDE_CONFIG_DIR` 或 `~/.claude`。安装器不会修改它。
- 工作文件仍在使用者选中的项目目录中。发送任务时，模型需要的提示词、图片和工具结果会传往使用者配置的渠道。
- 原始 API 密钥不应出现在界面状态、日志、截图、Issue 或公开仓库中。错误脱敏不能保证覆盖所有用户自行填写的秘密，提交反馈前仍需检查内容。

卸载应用不等于删除 Claude 原生配置或项目文件。不要删除不确定用途的配置目录。安全问题请先阅读 [SECURITY.md](SECURITY.md)。

## 开发与更新

```powershell
npm ci
npm run build
npm start
npm test
npm run test:desktop
npm run test:direct
```

源码更新后，退出工作台，再执行 `npm ci` 和 `npm run build`。保留个人 `local-data` 或指定的数据目录，不要将它提交到 Git。若 npm 被配置为跳过安装脚本，或启动时提示 Electron 运行时缺失，先执行 `npm run runtime:install`，成功后再启动；网络下载失败时应解决对应的 npm 或 Electron 访问问题，不要填写 API 密钥来“修复安装”。

常规自动测试使用本地接口与隔离目录。不要把生产配置、密钥或用户聊天样本写进测试；需要真实付费 API 的手动验证应在自己的本地环境单独进行。

安装包构建与发布说明随仓库的 GitHub Actions 工作流提供。发布前必须执行依赖安装、测试、构建和发布内容检查；不要把开发目录整体上传。

## 许可证与参考

本项目自己的代码按 [MIT License](LICENSE) 提供。Electron、Claude Agent SDK 以及其他依赖仍适用各自的许可证与服务条款；MIT 不授予 Claude 服务访问权。默认公开版素材使用项目提供的通用资源，个人图标与头像可在本地自行替换。

架构及交互参考包括 [Claude Agent SDK Demos](https://github.com/anthropics/claude-agent-sdk-demos)、[Happy](https://github.com/slopus/happy)、[Claude Code UI](https://github.com/siteboon/claudecodeui) 和 [Awesome DESIGN.md](https://github.com/voltagent/awesome-design-md)。参考不代表这些项目对本项目背书。贡献说明见 [CONTRIBUTING.md](CONTRIBUTING.md)。

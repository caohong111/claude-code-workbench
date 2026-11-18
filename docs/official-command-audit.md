# Claude Code 官方文档核对

核对日期：2026-11-18。依据实时获取的 Claude Code 官方文档与本机安装的 Claude Agent SDK 类型定义。Codex 截图只用于布局参考。

## 已核对的实现

| 功能 | 工作台行为与范围 |
| --- | --- |
| 新建、重命名、继续、复制、导出 | 管理工作台保存的可见对话；不会导出或复制 CLI 隐藏上下文 |
| 对话分支 | 创建独立的工作台对话副本；与原生后台 `/fork` 区分 |
| 模型、思考强度、权限模式 | 发送真实模型与 SDK 参数；权限规则继续由原有 Claude 配置生效，此页不编辑允许、询问、拒绝规则 |
| 自动压缩 | 区分当前 Claude 模型与所有模型默认值；单模型覆盖优先；模型级自动值写为 `auto`；环境变量覆盖时禁止误保存 |
| 快速模式 | 保存请求偏好并显式传入 SDK；是否可加速仍取决于模型、账户与服务，开关不代表服务已批准 |
| Chrome | 使用 Claude 官方扩展和真实连接检测；API Key、中转令牌不能替代官方付费账户登录 |
| MCP、插件、技能、代理、自动化 | 操作真实 Claude 配置、文档或官方 CLI；读取列表不会启动工具或执行用户脚本 |
| 同名自定义技能 | 独立显示实际技能；被覆盖的 SDK 原生命令不能冒充执行；设置按钮仍管理工作台偏好 |
| 回答风格 | 使用原生作用域配置；恢复默认必须明确覆盖上级风格 |
| 技能与插件重新扫描 | 在独立 SDK 查询中检查磁盘加载结果；每次聊天创建的新查询自然读取新配置，不宣称更新正在运行的查询 |
| 项目规则 | 编辑当前项目 `CLAUDE.md`；读取失败禁止保存；不包含自动记忆条目管理；GPT 渠道暂不应用 |
| 快捷键、状态栏 | 写入 Claude Code 终端配置；工作台输入框固定为回车发送、Ctrl + 回车换行 |

## 需要明确区分的功能

- `/fork` 是后台会话副本，不能用普通“创建分支”代替。当前未接入原生后台会话，命令标为不可用。
- `/cd` 保留原会话并迁移目录；工作台“打开文件夹”管理独立工作区，不等同于该命令。
- `/tasks` 管理后台工作，`/list-agents` 列出可通信代理和会话；工具日志不能替代二者，未接入的命令标为不可用。
- 工作台文件更改只包括捕获的修改快照，不代表完整 Git 工作树 `/diff`。
- 用量和上下文页面只展示已记录的请求用量，不代表原生上下文组成、账户套餐限制或实际账单。
- 主题、专注视图、重启作用于工作台；不会更改外部终端主题或安装 Claude Code 更新。
- 原生 Windows 沙箱、账户登录、云任务、远程控制等按实际平台和接入情况限制，不能仅凭出现菜单入口宣称支持。

完整命令目录不等于完整原生功能复现。目录根据官方基线和当前项目的 SDK 命令发现结果生成；未知内置命令不会当普通提示词模拟执行。

## 官方来源

- [命令参考](https://code.claude.com/docs/zh-CN/commands)
- [模型与自动压缩设置](https://code.claude.com/docs/zh-CN/model-config)
- [Agent SDK TypeScript 参考](https://code.claude.com/docs/zh-CN/agent-sdk/typescript)
- [快速模式](https://code.claude.com/docs/zh-CN/fast-mode)
- [Chrome 集成](https://code.claude.com/docs/zh-CN/chrome)
- [回答风格](https://code.claude.com/docs/zh-CN/output-styles)
- [技能](https://code.claude.com/docs/zh-CN/skills)
- [插件命令](https://code.claude.com/docs/zh-CN/plugins/cli-reference)
- [权限](https://code.claude.com/docs/zh-CN/permissions)
- [记忆](https://code.claude.com/docs/zh-CN/memory)
- [沙箱](https://code.claude.com/docs/zh-CN/sandboxing)

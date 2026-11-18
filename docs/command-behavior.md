# Command behavior and official reference audit

Audited against the public Claude Code documentation on 2026-11-18 and the
installed `@anthropic-ai/claude-agent-sdk` 0.3.326 type definitions. The public
documentation describes capabilities newer than some installed CLI versions.
The catalog therefore retains runtime discovery for generation commands.

Codex App is an interaction reference only. These operations do not execute or
require Codex. Claude-specific configuration is consumed by the Claude engine;
it does not configure the workbench's direct Responses engine.

## Interaction contract

| Commands | Appropriate panel behavior | Actual scope or prerequisite |
| --- | --- | --- |
| `/chrome` | Default-enable switch, official extension installation, connection requirements | Global `.claude.json`; a saved switch is not a successful connection. Official browser integration needs a direct paid Claude plan and `/login`. API keys and third-party credentials alone cannot activate it. |
| `/mcp` | Server list with add, remove, enable, disable and connection checks | Use official Claude configuration/SDK interfaces. A configured server is not necessarily connected. OAuth requires its own interactive authorization. |
| `/skills` | Editable local skill list and visibility selector | `skillOverrides`: `on`, `name-only`, `user-invocable-only`, `off`. Plugin and managed skills cannot be freely overridden. |
| `/agents` | Create and edit local agent Markdown files | User or project `agents` directories. Current official `/agents` directs users to these files; the old interactive manager was removed after v2.1.197. |
| `/hooks` | Inspect and edit hook definitions without running them as previews | `hooks` configuration is executable automation, not conversation text. Official `/hooks` itself is an inspection menu. |
| `/plugin` | Install, enable, disable, uninstall through Claude's plugin CLI | Report actual CLI success/error and pending reload. Do not infer installation from a settings Boolean. |
| `/output-style` | Select built-in style or edit local custom styles | Case-sensitive settings names: `Proactive`, `Concise`, `Explanatory`, `Learning`; absent means default. Custom files use `output-styles`. |
| `/keybindings` | Editable shortcut file | Claude terminal's `keybindings.json`, not Electron UI shortcuts. `{bindings:[{context,bindings:{chord:actionOrNull}}]}`. |
| `/statusline` | Configure or remove the status-line command | Claude terminal `statusLine` setting; it does not render an Electron status bar. Saving must not execute the command as a preview. |
| `/ide` | Auto-connect preference and official IDE extension entry | `autoConnectIde` is global `.claude.json` configuration. Opening an extension page does not establish a connection. |
| `/memory` | Read and save project `CLAUDE.md` | The current editor covers project instructions. Automatic-memory settings and entry management are additional official functionality, not implied by a successful `CLAUDE.md` save. |
| `/reload-skills` | Call SDK `reloadSkills()` and report refreshed counts | A catalog-file rescan alone is not the official reload operation. |
| `/reload-plugins` | Call SDK `reloadPlugins()` and report components/errors/cache impact | SDK reload is supported by modern Claude. Do not silently override a held cache-impact warning. Official noninteractive slash reload does not apply plugin MCP server changes. |
| `/autocompact` | Choose auto or a token window, with explicit configuration scope | 100,000-1,000,000 tokens. Current `/autocompact` saves per-model since v2.1.288; a top-level setting legitimately sets the default for all models but must be labeled that way. |
| `/permissions`, `/plan`, `/model`, `/effort`, `/fast` | Real selectors or switches with saved/effective state | Apply settings to the corresponding engine. Official account/model constraints still apply. |
| `/clear`, `/resume`, `/rename`, `/branch`, `/fork`, `/copy`, `/export` | Local history selection, forms, clipboard and save dialog | Workbench history operations are local equivalents. They do not imply management of official cloud/background sessions. |
| `/add-dir`, `/cd` | Native directory selection | Use actual workspace and additional-directory controls. |
| `/diff`, `/tasks`, `/list-agents` | Open workbench changes/activity views | Reflect actual captured local activity rather than fabricate background-agent control. |
| `/status`, `/usage` | Information view | Show only observed version, configuration, provider and local usage. Provider invoices determine actual third-party charges. |
| `/context` | Measured usage display | Current local usage is from the latest request, not a complete live Claude context composition. SDK `getContextUsage()` is available for a future actual composition view. |
| `/release-notes` | Official changelog entry | A changelog link is valid; local guessed release notes are not. |
| `/skill-doctor` | Unavailable until actual diagnostic report is attached | Listing local files does not establish token overhead or invocation frequency. Requires runtime version and feature availability. |
| `/sandbox` | Explicit unsupported state on native Windows | Official isolation supports macOS, Linux and WSL2. Permission prompts are not an operating-system sandbox. |
| `/login`, `/logout`, `/schedule`, `/remote-control`, `/teleport`, cloud review/account commands | Explicit account/integration requirement | A third-party model endpoint does not provide Anthropic cloud account capabilities. Never display success without implementing the real flow. |
| `/terminal-setup`, `/tui`, `/scroll-speed` | Explicit terminal-specific state | These configure a terminal renderer rather than the Electron application. |
| Bundled and project skills such as `/init`, `/doctor`, `/code-review`, `/compact`, `/run`, `/verify` | Form followed by a real Claude message | Only enable when actual SDK command discovery provides the command. Never treat arbitrary unknown native commands as model skills. |

## Configuration details that prevent false success

- Chrome and IDE default-enable settings are global configuration keys, not
  ordinary `settings.json` fields. With this installation's custom
  `CLAUDE_CONFIG_DIR`, global configuration remains under the configured D-drive
  directory.
- Official `modelSettings` keys use canonical model names, for example
  `claude-opus-5-5`. The CLI maps aliases, dated IDs, `[1m]` IDs and recognized
  provider IDs to those entries. A custom GUI must not guess a canonical name
  for an unknown provider model.
- `modelSettings[model].autoCompactWindow` accepts `"auto"` or a token count.
  Top-level `autoCompactWindow` accepts a token count. A per-model value wins
  over the top-level value in the same file. Higher-priority sources can win
  over user settings. `CLAUDE_CODE_AUTO_COMPACT_WINDOW` also overrides them.
- SDK metadata/control requests can reload skills and plugins, inspect MCP
  connections and reconnect/toggle servers without generating a model reply.
  Instantiating a new SDK process checks that process; it must not be labeled
  the connection status of an already-running separate process.
- Settings writes must preserve unrelated credentials, reject malformed input,
  make backups and reject paths outside the intended scope. Do not round-trip
  redacted secret placeholders into real configurations.

## Official sources

- [Commands](https://code.claude.com/docs/zh-CN/commands)
- [Chrome](https://code.claude.com/docs/zh-CN/chrome)
- [Settings reference](https://code.claude.com/docs/zh-CN/settings-reference)
- [Model configuration](https://code.claude.com/docs/zh-CN/model-config#set-the-auto-compact-window)
- [MCP](https://code.claude.com/docs/zh-CN/mcp)
- [Skills](https://code.claude.com/docs/zh-CN/skills#override-skill-visibility-from-settings)
- [Subagents](https://code.claude.com/docs/zh-CN/sub-agents)
- [Hooks](https://code.claude.com/docs/zh-CN/hooks)
- [Plugin CLI](https://code.claude.com/docs/zh-CN/plugins/cli-reference)
- [Output styles](https://code.claude.com/docs/zh-CN/output-styles)
- [Keybindings](https://code.claude.com/docs/zh-CN/keybindings)
- [Status line](https://code.claude.com/docs/zh-CN/statusline)
- [Sandboxing](https://code.claude.com/docs/zh-CN/sandboxing)

# Third-Party Notices

The MIT license in this repository covers this project's original wrapper code,
documentation, themes, and default artwork. It does not relicense dependencies,
Claude Code, the Claude Agent SDK, model services, or third-party trademarks.

- Claude Code and the Claude Agent SDK are provided by Anthropic and remain
  subject to the licenses and legal terms distributed with those packages.
  See https://github.com/anthropics/claude-agent-sdk-typescript and
  https://www.anthropic.com/legal/commercial-terms.
- Electron, React, Vite, React Markdown, remark-gfm, and the other JavaScript
  dependencies retain their respective licenses.
- Lucide icons are licensed under the ISC license. Default app/avatar PNGs are
  rendered from Lucide icons; see https://lucide.dev/license.
- `npm run licenses:collect` copies license/notice files from installed production
  dependencies into `build/third-party-licenses`. Release installers include that
  directory as `resources/licenses`.

This is an independent project, not an official Anthropic or OpenAI product.
The interface references common coding-workbench patterns; no code was copied
from the architecture/design reference projects listed in the project docs.

# Contributor Instructions

This is the public source tree. Never copy a user's configuration, credentials,
chat history, attachments, generated images, cache, or runtime data into it.
Keep personal machine paths and provider domains out of examples. Examples must
use clear placeholders and synthetic fixture credentials.

Read README.md before installing. On Windows, use install.ps1 to build from
source. Do not change the user's Claude settings or authentication unless they
explicitly request it. Reuse CLAUDE_CONFIG_DIR or the normal ~/.claude directory.
Users supply their own account or API credentials outside the source tree.

Run npm test, npm run audit:release, and npm run build for changes. For media,
themes, permissions, or provider routing, run the related Electron fixture tests.
Tests must use isolated local providers; never send paid model requests by
default. Windows x64 is the currently packaged target.

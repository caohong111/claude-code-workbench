# Security

Never attach API keys, OAuth tokens, Claude credential files, session/history
databases, raw configuration, or unredacted logs to an issue or pull request.
Use GitHub private vulnerability reporting when enabled. Do not publish an
exploit containing another user's credentials in a public issue.

The renderer uses an isolated preload API and has no Node integration. Provider
credentials are read locally by the main process. Messages and selected images
are sent to the provider configured by the user. Histories and attachments remain
in that user's local data directory. There is no project-hosted proxy or shared
API key. Dependencies and the selected provider may have their own data policies.

File-edit approvals and workspace boundaries reduce mistakes; they are not a
security sandbox for untrusted code. An approved shell command can access the
user account's files. Inspect commands and changes before approving them.

Before releasing, run `npm run audit:release`, review the Git diff, inspect the
packaged file list, and run the configured secret scanner. Automated checks
cannot prove that a repository contains no sensitive data. If a real secret was
committed, revoke it first; deleting the latest file does not remove Git history.

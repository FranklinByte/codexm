# codexm

Local-only Codex account manager for personal use.

## Install

From GitHub:

```bash
npm install -g git+https://github.com/FranklinByte/codexm.git
```

On a fresh machine, add accounts with:

```bash
codexm a
codexm l
```

This tool is intentionally small:

- no npm dependencies
- no telemetry
- no token printing
- no background service
- no silent account deletion; offline cleanup is interactive unless you pass `--yes`
- automatic token refresh for normal `list` / `use` workflows, but only when the access token is within 5 minutes of expiry
- active `codexm run` sessions are marked in-use so another terminal will not rotate that account's refresh token
- account switching does not silently re-add an active auth that was removed from the store
- accounts without a 5h window are treated as long-window-only accounts
- usage and refresh requests only go to OpenAI/ChatGPT endpoints

It stores accounts in:

```text
~/.codex/codexm-accounts.json
```

Running Codex sessions are tracked without secrets in:

```text
~/.codex/codexm-sessions.json
```

The active Codex login remains:

```text
~/.codex/auth.json
```

## Commands

```powershell
codexm doctor
codexm sync-codexs
codexm l
codexm l --json
codexm u 1
codexm u user@example.com
codexm u
codexm a
codexm refresh all
codexm refresh all --force
codexm run --help
codexm r
codexm r 1 --yes
```

Short aliases are supported: `i`, `a`, `l`, `u`, `r`.

By default, `list` and `use` refresh access tokens only when they are expired or within 5 minutes of expiry, and they skip accounts currently marked in-use by `codexm run`. Use `list --no-refresh` only when you explicitly want a diagnostic run without token refresh. `refresh --force` overrides the in-use guard.

`sync-codexs` overwrites the codexm store with the current `codexs` account store. `import-codexs` merges instead.

## Network Endpoints

Usage checks call:

```text
https://chatgpt.com/backend-api/wham/usage
```

Token refresh calls:

```text
https://auth.openai.com/oauth/token
```

No other network endpoints are used by this script.

## Windows + WSL

Use one shared account store to avoid refresh-token drift between Windows and WSL. Keep each environment's active auth file local, but point WSL at the Windows codexm account store:

```bash
export CODEXM_STORE=/mnt/c/Users/<WindowsUser>/.codex/codexm-accounts.json
```

Add that line to `~/.bashrc` or `~/.zshrc` in WSL. Also wrap the official Codex CLI so refreshes performed by Codex are copied back into the shared store:

```bash
alias codex='codexm run'
```

After this, `codexm list`, `codexm use`, `codexm refresh`, and `codexm run` read and update the shared account store; when the current account matches, codexm also syncs the refreshed token into the local `~/.codex/auth.json`. It does not write local auth back to the shared store during account switching, and switching will not re-add an active account that you removed from the store; only `codexm run` copies auth back after the official Codex CLI actually changes `auth.json`. While `codexm run` is active, other terminals see that account as `in-use` and will not rotate its refresh token during list/refresh checks.

## Environment Variables

```text
CODEX_HOME
CODEXM_STORE
CODEXM_TIME_ZONE
CODEXM_REFRESH_GRACE_SECONDS
CODEXM_SESSION_STORE
CODEXM_SESSION_STALE_MS
CODEXM_SESSION_HEARTBEAT_MS
CODEX_SAFE_STORE
CODEX_BIN
CODEX_USAGE_ENDPOINT
CODEX_REFRESH_TOKEN_URL_OVERRIDE
NO_COLOR
```

`CODEX_HOME` lets you test against a temporary Codex home instead of touching `~/.codex`. Reset times are displayed in `Asia/Singapore` by default; set `CODEXM_TIME_ZONE` to override it. `CODEXM_REFRESH_GRACE_SECONDS` defaults to `300`, so normal list checks do not rotate refresh tokens unless the access token is actually near expiry.

## Notes

The behavior is inspired by the locally installed `@uninto/codexs` package, but this implementation is written as a self-contained personal script with visible source and no external dependencies.

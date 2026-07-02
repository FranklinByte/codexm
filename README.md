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
- automatic token refresh for normal `list` / `use` workflows
- usage and refresh requests only go to OpenAI/ChatGPT endpoints

It stores accounts in:

```text
~/.codex/codexm-accounts.json
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
codexm r
codexm r 1 --yes
```

Short aliases are supported: `i`, `a`, `l`, `u`, `r`.

By default, `list` and `use` refresh access tokens that are missing or close to expiry. Use `list --no-refresh` only when you explicitly want a diagnostic run without token refresh.

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

## Environment Variables

```text
CODEX_HOME
CODEXM_STORE
CODEX_SAFE_STORE
CODEX_BIN
CODEX_USAGE_ENDPOINT
CODEX_REFRESH_TOKEN_URL_OVERRIDE
NO_COLOR
```

`CODEX_HOME` lets you test against a temporary Codex home instead of touching `~/.codex`.

## Notes

The behavior is inspired by the locally installed `@uninto/codexs` package, but this implementation is written as a self-contained personal script with visible source and no external dependencies.


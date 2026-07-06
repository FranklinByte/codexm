# codexm

Safe local Codex account switcher for personal Windows + WSL use.

This version is intentionally boring and avoids hidden token refresh during normal listing/switching. It vendors/adapts the locally installed `@uninto/codexs@0.1.8` MIT package, with safer multi-environment behavior:

- no `codexm run`
- no aliasing or wrapping the official `codex` command
- no session / in-use tracking
- no shared Windows + WSL store
- no automatic reverse sync from current `auth.json` into the account store during `list` or `use`
- `list` is read-only for stored tokens: it queries usage but does not call the OAuth refresh endpoint
- switching is one-way: codexm store -> `~/.codex/auth.json`
- account store shape matches codexs: `{ "version": 1, "accounts": [auth, ...] }`

`codexm` uses its own default store path:

```text
~/.codex/codexm-accounts.json
```

The active Codex login remains:

```text
~/.codex/auth.json
```

## Commands

```bash
codexm doctor
codexm sync-codexs
codexm init
codexm add
codexm list
codexm use 1
codexm use user@example.com
codexm use
codexm remove
codexm remove 1
codexm help
```

Short aliases are supported: `i`, `a`, `l`, `u`, `r`, `sync`.

After switching, run the official Codex command directly:

```bash
codexm use 2
codex
```

Do not alias `codex` to `codexm run`. `codexm run` has been removed.

## Windows + WSL

Keep Windows and WSL stores independent. If one side has a good, current store and the other side has a stale store, copy once manually:

```bash
cp /mnt/c/Users/<WindowsUser>/.codex/codexm-accounts.json /root/.codex/codexm-accounts.json
chmod 600 /root/.codex/codexm-accounts.json
```

Do not set WSL `CODEXM_STORE` to the Windows file for daily use.

## Environment

```text
CODEX_HOME    optional test/alternate Codex home
CODEXM_STORE  optional explicit codexm account store path
CODEX_BIN     optional official codex executable path
```

## Notes

This project vendors/adapts MIT-licensed source from `@uninto/codexs@0.1.8`. Display text and the store filename are codexm-specific. Unlike codexs 0.1.8, normal `list` does not refresh stored tokens, so copying a store between Windows and WSL is less likely to invalidate the other side by merely checking quotas.
# Key Clarity

Switch Claude Code and Codex between your [LiteLLM](https://github.com/BerriAI/litellm) virtual keys in one click, and see each key's spend, budget and expiry without leaving VS Code.

> Status: early (0.1.0). Not yet on the Marketplace. Install from a `.vsix` (see [Development](#development)).

## What it does

- **One list of your keys.** A **Key Clarity** view in the Activity Bar shows every key you've added, with spend against budget and days until expiry. Your other keys on the proxy appear under **Other keys on the proxy**.
- **Add or create keys.** Paste an existing key, or generate a new one with a name, allowed models, budget and expiry.
- **One-click switching** for Claude Code, Codex, or both. This covers the VS Code panels and the `claude` and `codex` commands, because each tool's panel and CLI read the same config file.
- **Per-workspace keys for Claude Code**, so each repo can bill to its own key.
- **Status bar badge**, such as `alpha · $12.40 / $50.00`. Click it to switch.
- **Warnings** when a key in use is near its budget, near expiry, or blocked.
- **Clean undo.** *Stop Managing Claude Code / Codex* puts your settings back the way they were.

## Getting started

1. Run **Key Clarity: Set Up Proxy** and enter your proxy's base URL, such as `https://litellm.example.com`.
2. Click **+** in the Key Clarity view and paste a key, or click the sparkle icon to generate one.
3. Choose **Use for Claude Code and Codex**.
4. Start a new Claude Code session and restart Codex. After this first setup, switching keys needs no restart: according to both tools' docs, running sessions re-read the key within about a minute.

If the Claude Code panel still asks you to sign in, accept Key Clarity's offer to turn on `claudeCode.disableLoginPrompt`.

## How it works

Key Clarity never writes a key into Claude Code or Codex config. Each tool instead gets a small command that reads the active key from a file:

| Tool | What Key Clarity writes | How the key is read |
| --- | --- | --- |
| Claude Code | `~/.claude/settings.json`: `env.ANTHROPIC_BASE_URL`, `apiKeyHelper`, `env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS` | `apiKeyHelper` runs `cat ~/.key-clarity/claude.key` |
| Claude Code, one workspace | `<workspace>/.claude/settings.local.json`, same keys | `cat ~/.key-clarity/workspaces/<name>-<id>.key` |
| Codex | `~/.codex/config.toml`: `[model_providers.key-clarity]` plus root `model_provider` (and `model`, if you pick one) | `[model_providers.key-clarity.auth]` runs `cat ~/.key-clarity/codex.key` |

- **Where keys live.** Keys are kept in VS Code's secret storage. The key in use for each tool is also mirrored to a `0600` file in `~/.key-clarity` (a `0700` folder). That's the same protection Claude Code and Codex give their own credential files, and it lets the CLIs read the key when VS Code isn't running.
- **Edits keep your settings.** Only the keys listed above change. Comments, formatting, hooks, MCP servers and everything else are left alone. Each edit is re-parsed and checked before it's written.
- **Backups and undo.** Before its first change to a file, Key Clarity saves a copy next to it as `*.key-clarity-backup`. It also records the values it replaced and restores them when you stop managing that tool.
- **Conflicting credentials.** Claude Code uses `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY` and cloud-provider settings before `apiKeyHelper`. Key Clarity warns if any of these is set, and offers to remove it from `settings.json`. It comes back when you stop managing Claude Code.
- **Workspace settings stay out of git.** If `.claude/settings.local.json` isn't ignored, Key Clarity offers to add it to `.git/info/exclude`. The file holds your proxy URL, not the key.

## Commands

| Command | What it does |
| --- | --- |
| Key Clarity: Set Up Proxy | Set the LiteLLM proxy URL |
| Key Clarity: Add Existing Key / Generate New Key | Store a key, or create one on the proxy |
| Key Clarity: Switch Key | Pick a key, then Claude Code, Codex, or both |
| Key Clarity: Choose Codex Model | Pick from the models the Codex key may call |
| Key Clarity: Set Account Key | Optional separate key used to list and create keys |
| Key Clarity: Stop Managing Claude Code / Codex | Undo Key Clarity's changes for that tool |

Right-click a key for Rename, Copy Key, Remove from Key Clarity, and Delete on Proxy.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `keyClarity.proxyUrl` | | LiteLLM proxy base URL |
| `keyClarity.refreshIntervalMinutes` | `5` | How often spend is refreshed |
| `keyClarity.budgetWarningPercent` | `90` | Warn at this share of a key's budget |
| `keyClarity.expiryWarningDays` | `3` | Warn this many days before expiry |
| `keyClarity.claude.helperTtlMs` | `60000` | How often Claude Code re-reads the key (`0` keeps Claude Code's 5-minute default) |
| `keyClarity.codex.providerId` | `key-clarity` | Codex provider id |
| `keyClarity.terminal.exportVariables` | `false` | Also set `LITELLM_PROXY_*` and `OPENAI_*` in new terminals |

## Limitations

- **Creating keys** needs permission on the proxy. By default LiteLLM only lets admins create keys; an admin can allow other roles with `key_generation_settings`. Adding existing keys always works.
- **Per-workspace keys are Claude Code only.** Codex doesn't let project config change providers or credentials.
- **Codex needs the Responses API** (`wire_api = "responses"`) on your proxy, which current LiteLLM versions provide.
- **Windows** is untested. Claude Code's helper runs `cat` through Git Bash; Codex's runs `cmd /c type`.

## Development

```bash
npm install
npm test               # unit tests, including a mock LiteLLM proxy
npm run test:e2e       # real claude / codex CLIs against the mock proxy (skipped if not installed)
npm run test:vscode    # the extension inside a headless VS Code (needs a display, e.g. Xvfb)
npm run package        # builds dist/key-clarity.vsix
code --install-extension dist/key-clarity.vsix
```

Background research: [docs/report.md](docs/report.md).

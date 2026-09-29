# Key Clarity

Switch Claude Code and Codex between your [LiteLLM](https://github.com/BerriAI/litellm) virtual keys in one click, and see each key's spend, budget and expiry without leaving VS Code.

> Status: early (0.1.0). Not on the Marketplace yet.

## Install

1. Download `key-clarity.vsix` from the [latest release](https://github.com/clarityorbital/key-clarity/releases/latest).
2. In VS Code, open the Extensions view, click **…** at the top, choose **Install from VSIX…**, and pick the file.
   From a terminal instead: `code --install-extension key-clarity.vsix`.
3. Look for the key icon (**Key Clarity**) in the Activity Bar. If it isn't there, run **Developer: Reload Window**.

**Dev containers and SSH:** install from a window connected to the container or host, where Claude Code and Codex run. Key Clarity runs there and edits the config files on that machine.

**Trying it safely:** "Use for Claude Code" switches every Claude Code session on that machine, including ones already running. For a first test, right-click a key, choose **Use for Claude Code in This Workspace Only**, and use a scratch folder. **Stop Managing…** in the view's **…** menu undoes it.

## What it does

- **One list of your keys.** A **Key Clarity** view in the Activity Bar shows every key you've added, with spend against budget and days until expiry. Hover a key for its budget: a monthly (or weekly, daily) budget shows what's been spent this period, what's left, and when it resets; a total budget shows lifetime spend against the cap. Budget windows (LiteLLM 1.93 and later) show each window's limit and spend in the current window. Budgets set through a LiteLLM budget tier are shown too, and so are your user and team budgets, including your own monthly budget within a team (LiteLLM's team member budget). Your other keys on the proxy appear under **Other keys on the proxy**.
- **Add or create keys.** Paste an existing key, or generate a new one with a name, allowed models, budget (monthly, weekly, daily or total) and expiry.
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
| Claude Code | `~/.claude/settings.json`: `env.ANTHROPIC_BASE_URL`, `apiKeyHelper`, `env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS`, the [default flags](#claude-code-defaults) and the key's [models](#claude-code-models) | `apiKeyHelper` runs `cat ~/.key-clarity/claude.key` |
| Claude Code, one workspace | `<workspace>/.claude/settings.local.json`, same keys | `cat ~/.key-clarity/workspaces/<name>-<id>.key` |
| Codex | `~/.codex/config.toml`: `[model_providers.key-clarity]` plus root `model_provider` (and `model`, if you pick one) | `[model_providers.key-clarity.auth]` runs `cat ~/.key-clarity/codex.key` |

- **Where keys live.** Keys are kept in VS Code's secret storage. The key in use for each tool is also mirrored to a `0600` file in `~/.key-clarity` (a `0700` folder). That's the same protection Claude Code and Codex give their own credential files, and it lets the CLIs read the key when VS Code isn't running.
- **Edits keep your settings.** Only the keys listed above change. Comments, formatting, hooks, MCP servers and everything else are left alone. Each edit is re-parsed and checked before it's written.
- **Backups and undo.** Before its first change to a file, Key Clarity saves a copy next to it as `*.key-clarity-backup`. It also records the values it replaced and restores them when you stop managing that tool.
- **Conflicting credentials.** Claude Code uses `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY` and cloud-provider settings before `apiKeyHelper`. Key Clarity warns if any of these is set, and offers to remove it from `settings.json`. It comes back when you stop managing Claude Code.
- **Workspace settings stay out of git.** If `.claude/settings.local.json` isn't ignored, Key Clarity offers to add it to `.git/info/exclude`. The file holds your proxy URL, not the key.

### Claude Code defaults

When Key Clarity sets up Claude Code, it also turns on four variables that keep Claude Code's traffic on your proxy and avoid features some proxies reject. Each has its own setting, on by default:

| Setting | Writes | Effect |
| --- | --- | --- |
| `keyClarity.claude.disableNonessentialTraffic` | `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` | No telemetry, error reporting, auto-updates, release notes or feedback. Update Claude Code yourself (for example with your package manager) while this is on. |
| `keyClarity.claude.disableTelemetry` | `DISABLE_TELEMETRY=1` | Telemetry off. Already covered by the setting above; kept separate so telemetry stays off if you turn that one off. |
| `keyClarity.claude.disableExperimentalBetas` | `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` | No pre-release `anthropic-beta` headers or fields. MCP tool search is also off, so every MCP tool loads up front. |
| `keyClarity.claude.disableAdaptiveThinking` | `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1` | Opus 4.6 and Sonnet 4.6 use a fixed thinking budget. Newer models ignore it. |

Turning a setting off puts that variable back the way it was before Key Clarity: removed, or your own value. Key Clarity never writes `0`, because Claude Code treats `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=0` as on. If you set one of these yourself before Key Clarity, it's left alone either way. Changes apply to the active key right away; running sessions pick them up when they restart.

### Claude Code models

Your proxy usually names Claude models its own way, such as `claude-5-sonnet`, so Claude Code's built-in `opus`, `sonnet` and `haiku` models don't match anything on it. Each time a key is used for Claude Code, Key Clarity asks the proxy which models that key may call, picks the newest Opus, Sonnet, Haiku and Fable, and points Claude Code's models at them:

```json
"ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-5-opus[1m]",
"ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-5-sonnet[1m]",
"ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-4.5-haiku"
```

- **`[1m]`** tells Claude Code the model has a 1M-token context window, so it doesn't compact at 200K. Claude Code removes the suffix before sending the request, so your proxy sees `claude-5-opus`. Key Clarity adds it when your proxy reports a context window of 1M or more for the model (`max_input_tokens` in LiteLLM's model info). When the proxy doesn't say, it adds it to models that always run with 1M: Sonnet 5 and later, Opus 4.7 and later, and Fable. Opus 4.6 and Sonnet 4.6 get 1M only through a beta header, so they're left at 200K.
- With `[1m]`, Claude Code also sends the `context-1m-2025-08-07` value in the `anthropic-beta` header, even with `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` on. If your proxy rejects it, turn off `keyClarity.claude.use1mContext`.
- A family the key can't call is left alone, or put back to its previous value if Key Clarity set it for an earlier key. Haiku also runs Claude Code's background tasks, such as session titles, so a key with a Haiku model spends less on them.
- If the proxy can't be reached when VS Code starts, the models found last time stay in place.

| Setting | Default | |
| --- | --- | --- |
| `keyClarity.claude.setModels` | `true` | Set Claude Code's models from the key |
| `keyClarity.claude.use1mContext` | `true` | Add `[1m]` to models with a 1M window |

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
| `keyClarity.claude.disableNonessentialTraffic`, `.disableTelemetry`, `.disableExperimentalBetas`, `.disableAdaptiveThinking` | `true` | See [Claude Code defaults](#claude-code-defaults) |
| `keyClarity.claude.setModels`, `.use1mContext` | `true` | See [Claude Code models](#claude-code-models) |
| `keyClarity.codex.providerId` | `key-clarity` | Codex provider id |
| `keyClarity.terminal.exportVariables` | `false` | Also set `LITELLM_PROXY_*` and `OPENAI_*` in new terminals |

## Security

- Key Clarity's settings can only be set in your user (or remote machine) settings, never by a workspace. A cloned repo can't redirect your keys to another proxy.
- It only runs in trusted workspaces.
- It never follows redirects from the proxy, and it warns before using plain `http` to a non-local proxy.
- Credentials it removes from `settings.json` are kept in VS Code's secret storage until they are restored.

## Uninstalling

Run **Stop Managing Claude Code** and **Stop Managing Codex** first. Uninstalling VS Code extensions can't run cleanup, so otherwise Claude Code and Codex keep reading keys from `~/.key-clarity`. Afterwards you can delete `~/.key-clarity`.

## Limitations

- **Creating keys** needs permission on the proxy. By default LiteLLM only lets admins create keys; an admin can allow other roles with `key_generation_settings`. Adding existing keys always works.
- **Per-workspace keys are Claude Code only.** Codex doesn't let project config change providers or credentials.
- **Codex needs the Responses API** (`wire_api = "responses"`) on your proxy, which current LiteLLM versions provide.
- **Windows:** the helpers use `cmd.exe` (`type "…\claude.key"` for Claude Code, `cmd /c type` for Codex). Tested by hand on one laptop so far; the automated tests run on Linux.

## Development

```bash
npm install
npm test               # unit tests, including a mock LiteLLM proxy
npm run test:e2e       # real claude / codex CLIs against the mock proxy (skipped if not installed)
npm run test:vscode    # the extension inside a headless VS Code (needs a display, e.g. Xvfb)
npm run package        # builds dist/key-clarity.vsix (attach it to a GitHub release for others)
code --install-extension dist/key-clarity.vsix
```

Background research: [docs/report.md](docs/report.md).

## License

[MIT](LICENSE) © Clarity Orbital Inc.

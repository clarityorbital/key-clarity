# Changelog

## 0.5.0

- Claude Code models. When a key is used for Claude Code, Key Clarity reads which models the key may call and points Claude Code's `opus`, `sonnet`, `haiku` and `fable` models at the newest of each (`ANTHROPIC_DEFAULT_*_MODEL`), so they work with your proxy's model names. The confirmation message lists them. Switching keys re-checks; a family the new key can't call goes back to its previous value.
- `[1m]` for models with a 1M-token context window: those your proxy reports at 1M or more, or, when it doesn't say, Sonnet 5 and later, Opus 4.7 and later, and Fable. Claude Code removes the suffix before sending requests, and sends the `context-1m-2025-08-07` beta value.
- New settings `keyClarity.claude.setModels` and `keyClarity.claude.use1mContext`, both on by default.

## 0.4.0

- Claude Code defaults. Setting up Claude Code now also turns on `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_TELEMETRY`, `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` and `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING`, so Claude Code only talks to your proxy and doesn't send features some proxies reject. Each has its own `keyClarity.claude.*` setting, on by default. Turning one off puts the variable back the way it was before Key Clarity. Keys already in use pick the defaults up when VS Code starts.
- Changing `keyClarity.claude.helperTtlMs` now applies to the key in use right away, and setting it to `0` removes the variable Key Clarity wrote. Before, the old value stayed until you stopped managing Claude Code.

## 0.3.3

- Budget windows. LiteLLM 1.93 lets a key have several budgets that each reset on their own schedule, such as $200 a month and $20 a day (**Budget Windows** when generating a key). Key Clarity now shows them: the list shows the window closest to its limit, such as `$42.00 / $200.00 monthly`, and the hover shows each window's limit, spend in the current window, amount left and reset date, plus the key's all-time spend. You're warned when a window is nearly used up.
- LiteLLM's Monthly window (`30d`) resets on the 1st of each month, so it's shown as monthly and its spend counts from the 1st. Likewise `24h` is daily and `7d` weekly.
- LiteLLM doesn't record spend per window, so Key Clarity adds up the key's daily spend since the window began, read with the key itself or with another of your keys. Days are UTC. It isn't shown for keys under **Other keys on the proxy**.

## 0.3.2

- Team member budgets. When your team gives each member their own budget, such as $200 a month on top of the team's total, a key in that team now shows it: `$12.40 spent · you: $150.00 / $200.00 monthly`. The hover lists it under **Your budget in team …**, with spend this month, the amount left and the reset date, above the team's total budget. You're warned when it's nearly used up.

## 0.3.1

- User and team budgets. When your LiteLLM user or team has a budget, such as $200 a month across all your keys, a key's hover shows it with spend this period, the amount left and the reset date. A key with no budget of its own shows it in the list too: `$12.40 spent · you: $150.00 / $200.00 monthly`. You're warned when a user or team budget is nearly used up.
- Fixed spend and **Other keys on the proxy** sometimes going missing. Without an account key, Key Clarity used the key active for Claude Code or Codex to read from the proxy, even when that key was limited to model calls and couldn't. It now uses the first of your keys the proxy lets read key info.

## 0.3.0

- Monthly budgets. A key whose budget resets on a schedule (LiteLLM's `budget_duration`) now shows as `$12.40 / $200.00 monthly`. Hovering it shows the budget per period, spend this period with the amount left, and when it resets. Total budgets show as `$500.00 total`.
- Keys linked to a LiteLLM budget tier show the tier's budget and reset period when the key has none of its own.
- Budget warnings name the period and when it resets, such as "has used 95% of its monthly budget … it resets in 4 days."
- **Generate New Key** asks how often the budget resets: monthly, weekly, daily, or never (total).

## 0.2.1

- The publisher ID is now `clarity-orbital`, matching the Marketplace publisher, so the extension ID is `clarity-orbital.key-clarity`. If you installed an earlier build from a `.vsix`, uninstall `clarityorbital.key-clarity` first. The two IDs keep their stored keys separately.

## 0.2.0

Security hardening, and preparation for the VS Code Marketplace.

- Key Clarity's settings (`proxyUrl`, `codex.providerId`, `claude.helperTtlMs`, `terminal.exportVariables`) can now only be set in user or remote-machine settings. Before, a cloned repo's `.vscode/settings.json` could point Key Clarity at another server and send it your keys.
- Key Clarity only runs in trusted workspaces.
- Credentials removed from `settings.json` are kept in VS Code's secret storage, not plain extension state.
- Key Clarity refuses to edit a workspace's `.claude/settings.local.json` through a symbolic link. Backups of that file are kept in `~/.key-clarity/backups`, not in the repo.
- Symlinked user config (for example from a dotfiles manager) is updated in place instead of being replaced.
- Proxy requests never follow redirects. Key Clarity warns before using plain `http` to a non-local proxy. Proxy error text is sanitized before it's shown.
- On Windows, key folder paths containing characters `cmd.exe` would reinterpret are refused.
- If `codex.providerId` changes, the old provider table is cleaned up.
- New icon, MIT license, and Marketplace listing details.

## 0.1.2

- Fix Claude Code on Windows. Claude Code runs `apiKeyHelper` through `cmd.exe`, where the helper failed with "'cat' is not recognized". The Windows helper now uses `type`.
- Key Clarity re-applies its Claude Code and Codex settings when VS Code starts, so fixes like this take effect without switching keys again.

## 0.1.1

- Support keys that the proxy limits to model calls (`llm_api_routes`). These keys used to be rejected when added. Now they show as working, with "spend not shown". Set an account key with key-management access to see their spend.

## 0.1.0

- First release: a sidebar of LiteLLM virtual keys with spend, budget and expiry.
- Add existing keys, or generate new ones.
- One-click switching for Claude Code (globally or per workspace) and Codex.
- Status bar badge, budget and expiry warnings, and a clean undo of every config change.

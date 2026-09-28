# Changelog

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

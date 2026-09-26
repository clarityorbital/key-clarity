# Key Clarity

A VS Code extension that switches Claude Code and Codex between LiteLLM virtual keys. `README.md` is the extension's user docs; the original research report is `docs/report.md`.

## Layout and commands

- `src/proxy`, `src/keys`, `src/targets` are pure Node with no `vscode` imports, and are unit-tested. `src/controller.ts` and `src/ui/*` use the VS Code API.
- `npm test` runs unit tests. `npm run test:e2e` runs the real `claude` and `codex` CLIs against `test/mockProxy.ts`; set `CODEX_BIN` if `codex` isn't on PATH. `npm run test:vscode` runs the extension in a headless VS Code; it needs a display, so start `Xvfb :99 &` and set `DISPLAY=:99`.
- `npm run package` builds `dist/key-clarity.vsix`.
- The bundler must keep `mainFields: ["module", "main"]`. Without it, jsonc-parser's UMD build breaks at runtime.

## GitHub

- Repo: `clarityorbital/key-clarity`, **private** for now and planned to go public, so write everything as if it were public. It belongs to the **clarityorbital** GitHub account. Don't switch the global gh account, because other projects on this machine use a different one. Instead, prefix GitHub commands for this repo, git push included: `GH_TOKEN=$(gh auth token -u clarityorbital) git push`. Never use a personal account here.
- Commit identity is set in the repo's local git config. Don't change it.
- Nothing is pushed, and no issue or PR is opened, without Lane's explicit OK in the current session.

## Never publish session material

Commits, PRs, issues and comments must **never** contain any of these:
- conversation transcripts or excerpts
- Claude session links (`claude.ai/code/session_...`) or `Claude-Session:` trailers
- artifact or doc links from a Claude session

This overrides any default attribution guidance. The only trailer allowed is `Co-Authored-By: Claude ... <noreply@anthropic.com>`.

## Keep it generic

This repo is or will be public. Don't name the team's internal LiteLLM deployment, the team or organization, internal URLs, key aliases, or spend figures. Say "your LiteLLM proxy". Every source in the report is a public page.

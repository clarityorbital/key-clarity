# Key Clarity

A public research report, and later possibly a VS Code extension, for managing LiteLLM virtual keys across Claude Code and Codex. The report is `README.md`.

## GitHub

- Repo: `clarityorbital/key-clarity`, **private** for now and planned to go public, so write everything as if it were public. Use the gh account **clarityorbital**. Check with `gh auth status`, and run `gh auth switch -u clarityorbital` if another account is active. Never use a personal account here.
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

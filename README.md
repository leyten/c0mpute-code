# c0mpute code

A coding agent whose **brain runs on the [c0mpute](https://c0mpute.ai) network** (the
`code` model — Devstral) while **file edits and commands run locally on your machine,
under your approval.** No single company can take it down, rate-limit it, or censor it —
and for private work you can point it at your own node.

## Quick start

```bash
npx @c0mpute/code                       # interactive, in your repo
npx @c0mpute/code "fix the failing test in test_api.py"   # one task, then exit
```

On first run it asks for your API key (get one at c0mpute.ai → settings → API keys)
and saves it to `~/.config/c0mpute-code/config.json`. Re-set it anytime with `/login`.
You can also pass it via the `C0MPUTE_API_KEY` env var.

## What it does
- Explores your repo, edits files, and runs commands/tests in a loop until the task is done.
- **Asks before every edit or command** (allow once / always / deny). Read-only commands
  (ls, cat, grep, git status…) run automatically.
- **Shows colored diffs** of every change.
- **Stays inside the project.** The directory you launch it in is the sandbox — any command
  that touches a file outside it has to be approved explicitly (even with `--yolo`).
- **Redacts secrets** (API keys, `.env` values, private keys, tokens) before anything is
  sent to the network. Your code is processed remotely, so for sensitive work run your own
  c0mpute worker and your code never leaves your trust boundary.
- The inference runs across the decentralized network; the dangerous parts (your files,
  your shell) never leave your machine.

## Options (env)
- `C0MPUTE_API_KEY` — your c0mpute API key (required)
- `C0MPUTE_MODEL` — model id (default `code`)
- `C0MPUTE_YOLO=1` — skip approval prompts (auto-run everything)
- `C0MPUTE_API_URL` — override the API base (default `https://c0mpute.ai/api/v1`)

Requires Node 18+.

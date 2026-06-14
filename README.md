# c0mpute code

A coding agent whose **brain runs on the [c0mpute](https://c0mpute.ai) network** (an
uncensored model on the max tier) while **file edits and commands run locally on your
machine, under your approval.** No single company can take it down, rate-limit it, or
censor it — it won't refuse legitimate work — and for private work you can point it at
your own node.

## Quick start

```bash
npx @c0mpute/code                       # interactive, in your repo
npx @c0mpute/code "fix the failing test in test_api.py"   # one task, then exit
```

On first run it asks for your API key (get one at c0mpute.ai → settings → API keys)
and saves it to `~/.config/c0mpute-code/config.json`. Re-set it anytime with `/login`.
You can also pass it via the `C0MPUTE_API_KEY` env var.

## What it does
- Works as an agent loop with real tools: **list, search, read, edit, write, run**. It locates
  the relevant code, reads it, makes a surgical edit, runs your tests, and stops when they pass.
- Edits are **small and targeted** (line-range replacements, or SEARCH/REPLACE snippets) —
  not whole-file rewrites — with a tolerant matcher so it doesn't fight whitespace.
- **Asks before every edit or command** (allow once / always / deny). Reads (list/search/read)
  run automatically.
- **Shows colored diffs** of every change.
- **Stays inside the project.** The directory you launch it in is the sandbox — any command
  that touches a file outside it has to be approved explicitly (even with `--yolo`).
- **Redacts secrets** (API keys, `.env` values, private keys, tokens) before anything is
  sent to the network. Your code is processed remotely, so for sensitive work run your own
  c0mpute worker and your code never leaves your trust boundary.
- The inference runs across the decentralized network; the dangerous parts (your files,
  your shell) never leave your machine.

## Sessions
- **Project memory**: it reads `c0mpute.md` (or `AGENTS.md` / `CLAUDE.md`) from the repo root as
  context. Run `/init` to generate a `c0mpute.md` for the current project.
- **Workspace**: each project gets a `.c0mpute/` workspace. After every verified task the agent
  logs what it did to `.c0mpute/journal.md` and reads it back on the next run, so it remembers
  past sessions. View it with `/workspace`. Commit it to share project history, or gitignore it.
- **Long sessions** stay within the model's context automatically (older steps are compacted).
- **Ctrl-C** interrupts the current task and returns to the prompt; again at the prompt exits.
- Edits are syntax-checked and auto-reverted if they would break the file.

## Options (env)
- `C0MPUTE_API_KEY` — your c0mpute API key (required)
- `C0MPUTE_MODEL` — model id (default `c0mpute-max`, the uncensored max model)
- `C0MPUTE_YOLO=1` — skip approval prompts (auto-run everything)
- `C0MPUTE_API_URL` — override the API base (default `https://c0mpute.ai/api/v1`)

Requires Node 18+.

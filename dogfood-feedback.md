# c0mpute-code dogfood feedback (leyten, 2026-06-14)

Running list of issues leyten hit while building a crime-analytics tracker site.
DO NOT fix until he says go — collecting first.

## 1. Dead air between actions ("goes dark")
Between steps (e.g. while writing), the spinner/indicator shows for ~2s then
disappears, and there's nothing on screen but that indicator during those 2s.
Feels like it hangs/goes blank between actions.
- Likely cause (to verify): in `think()`, the spinner stops at the FIRST streamed
  token, and prose streaming halts the moment a ``` fence appears; the action block
  itself isn't rendered until it's parsed+executed. So when the model emits little/no
  prose before a fenced action — and especially while generating a long action body
  (e.g. a 108-line write) — the spinner has already cleared and the action isn't shown
  yet → a blank gap with no feedback.
- Fix direction (later): keep a "working…" indicator alive until the action is parsed,
  and/or surface that an action (e.g. "writing server.js…") is being generated.

## 2. No closing summary on `done`
It just prints "▪ done" with no wrap-up — no recap of what it built or how to run/view
it (e.g. "open http://localhost:3000"). leyten wants a closing message.
- Cause: the `done` action's body (the model's one-line summary) IS captured into
  `doneSummary` for the journal, but never printed — the user only sees "▪ done".
- Fix direction (later): print the done summary/body as a closing message under "done"
  (and the model already tends to write run/verify info there). Could also nudge the
  system prompt so the done line includes how-to-run when it started a server.

### Aside (Kloot-observed in the same screenshot, NOT leyten-flagged):
The model ran `npm start & sleep 3 && echo ...` which "timed out after 120s" — it
launches a long-running server in the foreground and hits the 120s sh timeout. Then
it re-ran `node server.js & sleep 2 && curl ...` to verify. Worth handling background/
server commands (detach, or short timeout for `&`-backgrounded cmds) so server starts
don't show a scary "timed out" error. Flag to leyten before fixing.

---
## RESOLVED 2026-06-14 (v0.6.1, all four)
1. Dead air → think() keeps the indicator alive between prose lines and through the
   whole action-block generation (only paused while a line is actually printing).
2. Closing summary → `done` now prints the model's full summary (what it built + how
   to run/view), markdown-rendered. SYSTEM prompt nudges it to include run/open steps.
3. Server hang → sh() redirects output to a temp file so a backgrounded server doesn't
   hold the pipe (no false "timed out after 120s"); server stays running so you can open
   it. SYSTEM prompt tells the model to background long-running servers.
4. Text formatting → new mdLine() renders bold/italic/code/headers/bullets/numbered to
   ANSI; applied per completed prose line and to the done summary.
Verified: live run fixed a bug end-to-end and printed the closing summary; sh() returns
in <10ms with a backgrounded process; mdLine renders all cases.

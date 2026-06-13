#!/usr/bin/env node
// c0mpute code — decentralized coding agent.
// Thinking runs on the c0mpute network (the "code" model, devstral); file edits
// and commands run LOCALLY on your machine under your approval. No single company
// can take it down, rate-limit it, or censor it.
//
//   C0MPUTE_API_KEY=sk-... c0mpute-code        # interactive
//   C0MPUTE_API_KEY=sk-... c0mpute-code "task" # one task then exit
import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { createInterface } from 'readline';
import { stdin, stdout } from 'process';

// ── config ──
const API = (process.env.C0MPUTE_API_URL || 'https://c0mpute.ai/api/v1') + '/chat/completions';
const KEY = process.env.C0MPUTE_API_KEY;
const MODEL = process.env.C0MPUTE_MODEL || 'code';
const MAX_STEPS = Number(process.env.C0MPUTE_MAX_STEPS || 40);
const CWD = process.cwd();
const AUTO = process.env.C0MPUTE_YOLO === '1'; // skip permission prompts

// ── ansi ──
const e = (n) => (s) => `\x1b[${n}m${s}\x1b[0m`;
const c = { dim: e(2), bold: e(1), red: e(31), grn: e(32), yel: e(33), blu: e(34), cyn: e(36), mag: e(35), gry: e(90) };
const clip = (s, n = 4000) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + c.dim(`\n…[+${s.length - n} chars]`) : s; };

// ── secret redaction (client-side, before anything leaves the machine) ──
const SECRET_RX = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g, /\bAKIA[0-9A-Z]{16}\b/g, /\bghp_[A-Za-z0-9]{30,}\b/g,
  /\bgho_[A-Za-z0-9]{30,}\b/g, /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
  /(?<=(?:secret|token|password|passwd|api[_-]?key|access[_-]?key)["']?\s*[:=]\s*["']?)[A-Za-z0-9_\-./+=]{12,}/gi,
];
let redactN = 0, redactCount = 0;
function redact(text) {
  let t = String(text ?? '');
  for (const rx of SECRET_RX) t = t.replace(rx, () => { redactCount++; return `‹REDACTED-SECRET-${++redactN}›`; });
  return t;
}

// ── git diff helpers (for showing what changed) ──
const isGit = existsSync(`${CWD}/.git`);
const sh = (cmd) => { try { return execSync(cmd, { cwd: CWD, timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'], shell: '/bin/bash' }).toString(); } catch (x) { return `exit ${x.status}\n${x.stdout?.toString() || ''}\n${x.stderr?.toString() || ''}`; } };
const changedFiles = () => { if (!isGit) return new Set(); try { return new Set(execSync('git status --porcelain', { cwd: CWD }).toString().split('\n').map(l => l.slice(3).trim()).filter(Boolean)); } catch { return new Set(); } };
function renderDiff(paths) {
  if (!isGit || !paths.length) return;
  let d; try { d = execSync(`git --no-pager diff -- ${paths.map(p => `'${p}'`).join(' ')} 2>/dev/null; git --no-pager diff --cached -- ${paths.map(p => `'${p}'`).join(' ')} 2>/dev/null`, { cwd: CWD }).toString(); } catch { return; }
  // also show newly-created (untracked) files
  for (const p of paths) { if (existsSync(`${CWD}/${p}`) && !d.includes(p)) { try { const lines = readFileSync(`${CWD}/${p}`, 'utf8').split('\n').slice(0, 40); d += `\n+++ ${p} (new)\n` + lines.map(l => '+' + l).join('\n'); } catch {} } }
  if (!d.trim()) return;
  for (const line of d.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ')) console.log('   ' + c.bold(c.gry(line)));
    else if (line.startsWith('@@')) console.log('   ' + c.cyn(line));
    else if (line.startsWith('+')) console.log('   ' + c.grn(line));
    else if (line.startsWith('-')) console.log('   ' + c.red(line));
    else console.log('   ' + c.gry(line));
  }
}

// ── permission ──
const allowAll = { value: AUTO };
const session = new Set();
function ask(q) { return new Promise(r => { const rl = createInterface({ input: stdin, output: stdout }); rl.question(q, a => { rl.close(); r(a.trim()); }); }); }
async function permit(kind, detail) {
  if (allowAll.value || session.has(kind)) return true;
  console.log(c.yel(`\n   ⮕ ${kind}:`) + ` ${detail}`);
  const a = (await ask(c.bold('   allow? [y]es / [a]lways / [n]o: '))).toLowerCase();
  if (a === 'a') { session.add(kind); return true; }
  return a === 'y' || a === '';
}

// ── command classification: auto-allow obvious read-only ──
const SAFE = /^(ls|cat|head|tail|pwd|grep|rg|find|wc|echo|git (status|diff|log|show|branch)|python3? -m pytest|pytest|node --version|python3 --version)\b/;
const isSafe = (cmd) => cmd.split(/&&|\|\||;|\|/).every(p => SAFE.test(p.trim()));

// ── streaming chat to the c0mpute network ──
const SYSTEM = `You are c0mpute code, an autonomous coding agent in a local repo at ${CWD}.
Each turn: a brief THOUGHT (1-2 sentences), then exactly ONE bash command in a single \`\`\`bash code block.
The command runs in the repo; you get stdout/stderr next turn. Work in small steps: explore (ls/cat/grep),
edit (sed -i, or: cat > path <<'EOF' … EOF), and run tests to verify. Do not ask the user questions.
When the task is fully complete, output a THOUGHT then exactly:
\`\`\`bash
echo C0MPUTE_DONE
\`\`\``;

// Non-streaming + spinner. (c0mpute's SSE streaming path currently truncates
// responses — tracked as a separate API/worker bug; switch to stream:true here
// once it's fixed for live token output.)
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
async function think(messages) {
  let i = 0, tick = null;
  if (stdout.isTTY) tick = setInterval(() => process.stdout.write(`\r   ${c.mag(FRAMES[i++ % FRAMES.length])} ${c.dim('thinking on the c0mpute network…')}`), 80);
  else process.stdout.write(c.dim('   thinking on the c0mpute network…\n'));
  try {
    const r = await fetch(API, { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: MODEL, messages, temperature: 0.2, max_tokens: 1024 }) });
    if (!r.ok) throw new Error(`c0mpute API ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return (await r.json()).choices?.[0]?.message?.content || '';
  } finally { if (tick) { clearInterval(tick); process.stdout.write('\r\x1b[K'); } }
}

const parseCmd = (t) => { const m = String(t || '').match(/```(?:bash|sh)?\s*\n([\s\S]*?)```/); return m ? m[1].trim() : null; };

// ── agent loop for one task ──
async function runTask(task, history) {
  history.push({ role: 'user', content: task });
  for (let step = 1; step <= MAX_STEPS; step++) {
    const reply = await think(history.map(m => ({ ...m, content: redact(m.content) })));
    history.push({ role: 'assistant', content: reply });
    const thought = reply.split('```')[0].replace(/THOUGHT:?/i, '').trim();
    if (thought) console.log('   ' + c.gry(thought.replace(/\n/g, '\n   ')));
    const cmd = parseCmd(reply);
    if (!cmd) { console.log(c.dim('   (no command — stopping)')); break; }
    if (cmd.trim() === 'echo C0MPUTE_DONE') { console.log(c.grn('\n   ✓ done\n')); break; }
    console.log(c.cyn('   $ ') + cmd.replace(/\n/g, '\n     '));
    if (!isSafe(cmd) && !(await permit('run command', cmd.split('\n')[0]))) {
      history.push({ role: 'user', content: 'The user DENIED that command. Try a different approach.' });
      console.log(c.red('   ✗ denied')); continue;
    }
    const mutating = /(?:>|sed|tee|cat\s|cp\s|mv\s|rm\s|touch|mkdir|patch|install)/.test(cmd);
    const out = sh(cmd);
    console.log(c.gry('   ' + clip(out, 800).replace(/\n/g, '\n   ')));
    if (mutating) { const after = [...changedFiles()]; if (after.length) renderDiff(after); }
    history.push({ role: 'user', content: `Output:\n${redact(clip(out, 3000))}` });
  }
}

// ── main ──
async function main() {
  if (!KEY) { console.error(c.red('set C0MPUTE_API_KEY (get one at c0mpute.ai)')); process.exit(1); }
  console.log('\n' + c.bold(c.mag('  c0mpute code')) + c.dim(`  ·  model ${MODEL}  ·  ${isGit ? 'git repo' : 'no git (diffs off)'}`));
  console.log(c.dim('  decentralized brain, local hands. /exit to quit.\n'));
  const history = [{ role: 'system', content: SYSTEM }];
  const oneShot = process.argv.slice(2).join(' ').trim();
  const finish = () => { if (redactCount) console.log(c.dim(`\n  (${redactCount} secret${redactCount > 1 ? 's' : ''} redacted before leaving your machine)`)); };
  if (oneShot) { await runTask(oneShot, history); finish(); return; }
  while (true) {
    const task = await ask(c.bold(c.mag('\n  › ')));
    if (!task) continue;
    if (task === '/exit' || task === '/quit') { finish(); break; }
    if (task === '/help') { console.log(c.dim('  type a coding task. /exit to quit. commands need approval; reads auto-run.')); continue; }
    try { await runTask(task, history); } catch (x) { console.log(c.red('  ! ' + x.message)); }
  }
}
main();

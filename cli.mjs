#!/usr/bin/env node
// c0mpute code — decentralized coding agent.
// The brain runs on the c0mpute network (the "code" model, Devstral); file edits
// and commands run locally on your machine, under your approval. No single company
// can take it down, rate-limit it, or censor it.
//
//   C0MPUTE_API_KEY=sk-... c0mpute-code            # interactive
//   C0MPUTE_API_KEY=sk-... c0mpute-code "task"     # one task, then exit
import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { createInterface } from 'readline';
import { stdin, stdout } from 'process';
import { homedir } from 'os';
import { resolve, isAbsolute, join, dirname } from 'path';
import { fileURLToPath } from 'url';

// ── config ──
const API_BASE = process.env.C0MPUTE_API_URL || 'https://c0mpute.ai/api/v1';
const API = API_BASE + '/chat/completions';
const CFG_DIR = join(homedir(), '.config', 'c0mpute-code');
const CFG_FILE = join(CFG_DIR, 'config.json');
let KEY = process.env.C0MPUTE_API_KEY || '';
const MODEL = process.env.C0MPUTE_MODEL || 'code';
let VERSION = ''; try { VERSION = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8')).version || ''; } catch {}
const MAX_STEPS = Number(process.env.C0MPUTE_MAX_STEPS || 40);
const CWD = process.cwd();
const ROOT = CWD; // the project boundary: the agent may not touch files outside this without approval
const AUTO = process.env.C0MPUTE_YOLO === '1';

// ── ansi ──
const e = (n) => (s) => `\x1b[${n}m${s}\x1b[0m`;
const c = { dim: e(2), bold: e(1), red: e(31), grn: e(32), yel: e(33), blu: e(34), cyn: e(36), mag: e(35), gry: e(90), b: (s) => `\x1b[1m${s}\x1b[0m` };
// c0mpute brand: pure black, green accent (#5af78e), pixel square marker (not Claude's round/orange dot).
const MARK = c.grn('▪');
const vlen = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').length;
const clip = (s, n = 4000) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + c.dim(` … +${s.length - n} chars`) : s; };

// ── rounded box ── (width tracks the terminal so the right border never clips)
const wbox = () => Math.min(72, Math.max(46, (stdout.columns || 80) - 2));
function box(lines) {
  const W = wbox();
  const out = [c.gry('╭' + '─'.repeat(W - 2) + '╮')];
  for (const ln of lines) out.push(c.gry('│ ') + ln + ' '.repeat(Math.max(0, W - 4 - vlen(ln))) + c.gry(' │'));
  out.push(c.gry('╰' + '─'.repeat(W - 2) + '╯'));
  return out.join('\n');
}

// ── secret redaction (before anything leaves the machine) ──
const SECRET_RX = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g, /\bAKIA[0-9A-Z]{16}\b/g, /\bghp_[A-Za-z0-9]{30,}\b/g, /\bgho_[A-Za-z0-9]{30,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
  /(?<=(?:secret|token|password|passwd|api[_-]?key|access[_-]?key)["']?\s*[:=]\s*["']?)[A-Za-z0-9_\-./+=]{12,}/gi,
];
let redactCount = 0, redactN = 0;
const redact = (t) => { let s = String(t ?? ''); for (const rx of SECRET_RX) s = s.replace(rx, () => { redactCount++; return `‹REDACTED-${++redactN}›`; }); return s; };

// ── git / shell ──
const isGit = existsSync(`${CWD}/.git`);
const sh = (cmd) => { try { return execSync(cmd, { cwd: CWD, timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'], shell: '/bin/bash' }).toString(); } catch (x) { return `exit ${x.status}\n${x.stdout?.toString() || ''}\n${x.stderr?.toString() || ''}`; } };
const gitDiff = () => { if (!isGit) return ''; try { return execSync('git --no-pager diff', { cwd: CWD }).toString() + execSync('git --no-pager diff --cached', { cwd: CWD }).toString(); } catch { return ''; } };

// render a unified diff Claude-style: line numbers + colored +/- under the action
function renderDiff(diff) {
  let adds = 0, dels = 0, oldn = 0, newn = 0; const rows = [];
  for (const ln of diff.split('\n')) {
    if (ln.startsWith('@@')) { const m = ln.match(/-([0-9]+).*\+([0-9]+)/); if (m) { oldn = +m[1]; newn = +m[2]; } continue; }
    if (ln.startsWith('+++') || ln.startsWith('---') || ln.startsWith('diff ') || ln.startsWith('index ')) continue;
    if (ln.startsWith('+')) { adds++; rows.push(c.gry(String(newn).padStart(5)) + ' ' + c.grn('+ ' + ln.slice(1))); newn++; }
    else if (ln.startsWith('-')) { dels++; rows.push(c.gry(String(oldn).padStart(5)) + ' ' + c.red('- ' + ln.slice(1))); oldn++; }
    else { rows.push(c.gry(String(newn).padStart(5)) + '   ' + c.gry(ln.slice(1))); oldn++; newn++; }
  }
  return { adds, dels, rows };
}

// ── command → Claude-style action label ──
const SAFE = /^(ls|cat|head|tail|pwd|grep|rg|find|wc|echo|git (status|diff|log|show|branch)|python3? -m pytest|pytest|node --version|python3? --version)\b/;
const isSafe = (cmd) => cmd.split(/&&|\|\||;|\|/).every(p => SAFE.test(p.trim()));
function label(cmd) {
  const first = cmd.trim().split('\n')[0];
  let m;
  if ((m = first.match(/^cat\s+(?:-\w+\s+)*([^\s|>]+)\s*$/))) return { verb: 'Read', arg: m[1], write: false };
  // a real stdout redirect to a file — not 2>/dev/null, not &>/dev/null (fd/null discards)
  const redir = cmd.match(/(?<![0-9&])>>?\s*([^\s&|;]+)/);
  const redirWrite = redir && redir[1] !== '/dev/null';
  if (/\bsed\s+-i\b/.test(cmd) || /\btee\b/.test(cmd) || redirWrite || /^cat\s*>/.test(first)) {
    const f = (cmd.match(/\bsed\s+-i\b[^\n]*?\s([^\s&|;<>]+)\s*$/) || [])[1] || (redirWrite ? redir[1] : '') || (cmd.match(/\btee\s+([^\s&|;]+)/) || [])[1];
    return { verb: 'Update', arg: f || '', write: true };
  }
  return { verb: 'Bash', arg: first, write: false };
}

// ── streaming over the network ──
const PULSE = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█', '▇', '▆', '▅', '▄', '▃', '▂']; // compute pulse
async function think(messages) {
  let i = 0, tick = null, first = false;
  if (stdout.isTTY && !process.env.C0MPUTE_NO_SPINNER) tick = setInterval(() => { if (!first) process.stdout.write('\r' + c.grn(PULSE[i++ % PULSE.length]) + ' '); }, 80);
  const stop = () => { if (tick) { clearInterval(tick); tick = null; if (stdout.isTTY) process.stdout.write('\r\x1b[K'); } };
  try {
    const r = await fetch(API, { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: MODEL, messages, temperature: 0.2, max_tokens: 1024, stream: true }) });
    if (!r.ok) throw new Error(`c0mpute API ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = '', full = '', inCode = false, shown = false, prose = '', pp = 0;
    // stream prose, stripping the model's "THOUGHT:" label — withhold a 9-char tail
    // (len of "THOUGHT: ") so a half-arrived keyword never leaks to the screen.
    const flush = (final) => {
      const clean = prose.replace(/\bTHOUGHT:?\s*/gi, '');
      const upto = final ? clean.length : Math.max(pp, clean.length - 9);
      if (upto > pp) { process.stdout.write(clean.slice(pp, upto)); pp = upto; shown = true; }
    };
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true }); const lines = buf.split('\n'); buf = lines.pop() || '';
      for (const ln of lines) {
        if (!ln.startsWith('data:')) continue; const p = ln.slice(5).trim(); if (p === '[DONE]') continue;
        let tok = ''; try { tok = JSON.parse(p).choices?.[0]?.delta?.content || ''; } catch { continue; }
        if (!tok) continue;
        if (!first) { first = true; stop(); }
        full += tok;
        if (!inCode) {
          if (full.includes('```')) { inCode = true; flush(true); }
          else { prose += tok; flush(false); }
        }
      }
    }
    flush(true);
    if (shown) process.stdout.write('\n');
    return full;
  } finally { stop(); }
}
const parseCmd = (t) => { const m = String(t || '').match(/```(?:bash|sh)?\s*\n([\s\S]*?)```/); return m ? m[1].trim() : null; };

// ── filesystem boundary ──
// Return any path tokens in the command that resolve OUTSIDE the project root.
// Whole-word paths only (leading space) so we don't trip on URLs like https://…
function outOfBounds(cmd) {
  const hits = new Set();
  const toks = cmd.match(/(?:^|[\s=])((?:~\/|\.\.\/|\/)[^\s'"();|&<>]*)/g) || [];
  for (let raw of toks) {
    let t = raw.replace(/^[\s=]+/, '');
    if (t.startsWith('~')) t = join(homedir(), t.slice(1));
    const abs = isAbsolute(t) ? resolve(t) : resolve(ROOT, t);
    if (abs !== ROOT && !abs.startsWith(ROOT + '/')) hits.add(t);
  }
  return [...hits];
}

// ── permission (Claude-style) ──
const allow = { all: AUTO }; const session = new Set();
// One persistent readline for the whole session — a fresh interface per prompt
// drops buffered/piped input and fights itself on stdin.
let RL = null, closed = false;
function rl() { if (!RL) { RL = createInterface({ input: stdin, output: stdout }); RL.on('close', () => { closed = true; }); } return RL; }
const ask = (q) => new Promise(r => { if (closed) return r(''); rl().question(q, a => r(a.trim())); });
async function permit(verb, detail, warn) {
  if (!warn && (allow.all || session.has(verb))) return true; // out-of-bounds always asks, even in yolo
  const W = wbox();
  console.log('\n' + box([
    c.b(verb + ' wants to run:'), '', c.yel(detail.slice(0, W - 8)),
    ...(warn ? ['', c.red(warn.slice(0, W - 6))] : []),
  ]));
  const a = (await ask(`  ${c.b('1.')} yes   ${c.b('2.')} yes, don't ask again for ${verb}   ${c.b('3.')} no  › `)).toLowerCase();
  if (a === '2' && !warn) { session.add(verb); return true; }
  return a === '1' || a === '2' || a === 'y' || a === '';
}

// ── first-run API-key setup (Claude Code-style /login) ──
async function validateKey(k) { try { const r = await fetch(API_BASE + '/models', { headers: { Authorization: `Bearer ${k}` } }); return r.status !== 401; } catch { return true; } }
async function setupKey() {
  console.log('\n' + box([
    `${MARK} ${c.b('c0mpute code')}`,
    c.dim('first run. paste your api key to start.'),
    c.dim('get one at c0mpute.ai → settings → api keys'),
  ]));
  while (true) {
    const k = (await ask(`  ${c.b('›')} paste your c0mpute API key (sk-…): `)).trim();
    if (!k) continue;
    process.stdout.write('  ' + c.dim('checking… '));
    if (!(await validateKey(k))) { console.log(c.red('that key was rejected, try again')); continue; }
    KEY = k;
    try { mkdirSync(CFG_DIR, { recursive: true }); writeFileSync(CFG_FILE, JSON.stringify({ apiKey: k }, null, 2), { mode: 0o600 }); console.log(c.grn('saved') + c.dim(` → ${CFG_FILE.replace(homedir(), '~')}`)); } catch { console.log(c.yel('using for this session (could not write config)')); }
    return;
  }
}
async function ensureKey() {
  if (KEY) return;                       // env var wins
  try { const cfg = JSON.parse(readFileSync(CFG_FILE, 'utf8')); if (cfg.apiKey) { KEY = cfg.apiKey; return; } } catch {}
  await setupKey();                      // nothing saved → first-run flow
}

// ── one task ──
async function runTask(task, history) {
  console.log('');
  history.push({ role: 'user', content: task });
  let ran = false;
  for (let step = 1; step <= MAX_STEPS; step++) {
    const reply = await think(history.map(m => ({ ...m, content: redact(m.content) })));
    history.push({ role: 'assistant', content: reply });
    const cmd = parseCmd(reply);
    if (!cmd) break;
    if (cmd.trim() === 'echo C0MPUTE_DONE') break;
    const { verb, arg, write } = label(cmd);
    console.log(`${MARK} ${c.b(verb)}${c.gry('(')}${c.gry(arg || cmd.split('\n')[0])}${c.gry(')')}`);
    const oob = outOfBounds(cmd);
    const ok = oob.length
      ? await permit(verb, cmd.split('\n')[0], `⚠ this touches files OUTSIDE the project: ${oob.join(', ')}`)
      : (isSafe(cmd) || await permit(verb, cmd.split('\n')[0]));
    if (!ok) {
      console.log(`  ${c.gry('⎿')}  ${c.red('denied by user')}`);
      history.push({ role: 'user', content: 'The user DENIED that command (it may have reached outside the project directory). Stay inside the project and try another approach.' }); continue;
    }
    ran = true;
    const out = sh(cmd);
    if (write && isGit) {
      const { adds, dels, rows } = renderDiff(gitDiff());
      console.log(`  ${c.gry('⎿')}  ${c.dim(`Updated ${arg} with ${adds} addition${adds !== 1 ? 's' : ''} and ${dels} removal${dels !== 1 ? 's' : ''}`)}`);
      for (const row of rows.slice(0, 30)) console.log('     ' + row);
    } else {
      const lines = clip(out, 500).split('\n').filter(x => x.length);
      console.log(`  ${c.gry('⎿')}  ${c.dim(lines[0] || '(no output)')}`);
      for (const l of lines.slice(1, 8)) console.log('     ' + c.dim(l));
    }
    console.log('');
    history.push({ role: 'user', content: `Output:\n${redact(clip(out, 3000))}` });
  }
  if (ran) console.log(MARK + ' ' + c.dim('done') + '\n');
  else console.log('');
}

// ── main ──
async function main() {
  await ensureKey();
  // refuse to run loose in home/system dirs — there's no "project" boundary there and
  // the agent would freely read personal files and send their contents to the network.
  const SENSITIVE = new Set([homedir(), '/', '/root', '/home', '/etc', '/usr', '/var', '/bin', '/opt']);
  if (SENSITIVE.has(resolve(CWD))) {
    console.log('\n' + box([
      `${c.red('⚠ this is not a project directory')}`,
      c.dim(`you're in ${CWD.replace(homedir(), '~')} — the agent could read personal`),
      c.dim('files here and send them to the network. cd into a repo first.'),
    ]));
    const a = (await ask(`  continue here anyway? ${c.dim('(y/N)')} `)).toLowerCase();
    if (a !== 'y' && a !== 'yes') { console.log(c.dim('  exiting — cd into your project and run again.')); RL?.close(); return; }
  }
  console.log('\n' + box([
    `${MARK} ${c.b('c0mpute code')}${VERSION ? c.gry('  v' + VERSION) : ''}`,
    c.dim('your coding agent, running on the c0mpute network'),
    '',
    `${c.dim('model')}  ${MODEL}     ${c.dim('cwd')}  ${CWD.replace(homedir(), '~')}     ${c.dim(isGit ? 'git · diffs on' : 'no git')}`,
    c.dim('edits ask first · reads run automatically · /help for more'),
  ]));
  const history = [{ role: 'system', content: SYSTEM }];
  const fin = () => { if (redactCount) console.log(c.dim(`  ${redactCount} secret${redactCount > 1 ? 's' : ''} redacted before leaving your machine`)); };
  const one = process.argv.slice(2).join(' ').trim();
  if (one) { console.log('\n' + c.gry('│ ') + c.b('› ') + one); await runTask(one, history); fin(); RL?.close(); return; }
  while (true) {
    const task = await ask('\n' + c.gry('│ ') + c.b('› '));   // inline prompt — cursor sits right here
    if (closed) { console.log(''); fin(); break; }
    if (!task) continue;
    if (task === '/exit' || task === '/quit') { fin(); break; }
    if (task === '/login') { await setupKey(); continue; }
    if (task === '/help') { console.log(c.dim('  type a coding task. /login set API key · /exit quit. writes ask approval, reads auto-run, files outside this dir always ask.')); continue; }
    try { await runTask(task, history); } catch (x) { console.log(c.red('  ! ' + x.message)); }
  }
  RL?.close();
}

const SYSTEM = `You are c0mpute code: an open coding agent that lives in the user's terminal and works
on their projects (read, edit, run, debug). Your model runs on c0mpute's decentralized GPU network,
so you can't be taken down, rate-limited, or censored. You are not Claude, ChatGPT, or Copilot.

Identity: ONLY when explicitly asked who/what you are, answer briefly, e.g. "I'm c0mpute code, your
coding agent. I work on your projects right here in the terminal, and I run on c0mpute's
decentralized network." Never introduce yourself or restate this otherwise; for a coding task, skip
the intro and get straight to work. Voice: write with NORMAL capitalization and grammar like any
assistant. The ONLY thing kept lowercase is the brand name itself, "c0mpute" / "c0mpute code". Be
plain and direct, no hype, no emoji, no em dashes.

If the user's message is a greeting, small talk, or a question that needs no file changes
(e.g. "hey", "what are you?", "how does this work?"), just reply in plain text with NO
code block. Do NOT explore or read files for these — only a real coding/build/debug task
warrants running commands. When unsure whether something is a task, ask a one-line
clarifying question in plain text instead of poking at the filesystem.

For an actual coding task: each turn output a brief THOUGHT (1-2 sentences), then exactly ONE
bash command in a single \`\`\`bash code block. The command runs in the repo; you get
stdout/stderr next turn. Work in small steps: explore (ls/cat/grep), edit (sed -i, or
cat > path <<'EOF' … EOF), and run tests to verify. Do not ask the user questions mid-task.
When the task is fully complete, output a THOUGHT then exactly:
\`\`\`bash
echo C0MPUTE_DONE
\`\`\``;

main();

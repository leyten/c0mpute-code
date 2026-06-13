#!/usr/bin/env node
// c0mpute code — decentralized coding agent.
// The brain runs on the c0mpute network (the "code" model, Devstral); file edits
// and commands run locally on your machine, under your approval. No single company
// can take it down, rate-limit it, or censor it.
//
//   C0MPUTE_API_KEY=sk-... c0mpute-code            # interactive
//   C0MPUTE_API_KEY=sk-... c0mpute-code "task"     # one task, then exit
import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
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
// ── action protocol: model emits ONE fenced block per turn; first line is the command ──
const VERBS = new Set(['list', 'search', 'read', 'edit', 'write', 'run', 'done']);
function parseAction(text) {
  const m = String(text || '').match(/```([^\n]*)\n([\s\S]*?)```/);
  if (!m) return null;
  const info = m[1].trim(), body = m[2];
  let cmdline, rest;
  if (VERBS.has(info.split(/\s+/)[0]?.toLowerCase())) { cmdline = info; rest = body.replace(/\n+$/, ''); }
  else { const nl = body.indexOf('\n'); cmdline = (nl < 0 ? body : body.slice(0, nl)).trim(); rest = nl < 0 ? '' : body.slice(nl + 1).replace(/\n+$/, ''); }
  const sp = cmdline.search(/\s/);
  const verb = (sp < 0 ? cmdline : cmdline.slice(0, sp)).toLowerCase();
  const arg = sp < 0 ? '' : cmdline.slice(sp + 1).trim();
  return VERBS.has(verb) ? { verb, arg, body: rest } : null;
}

// ── local file tools (run on the user's machine; the network only sees what we send back) ──
const abspath = (p) => isAbsolute(p) ? resolve(p) : resolve(ROOT, p);
const within = (p) => { const a = abspath(p); return a === ROOT || a.startsWith(ROOT + '/'); };
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
function toolRead(arg) {
  const [path, s, e] = arg.split(/\s+/);
  const start = parseInt(s) || 0, end = parseInt(e) || 0;
  let txt; try { txt = readFileSync(abspath(path), 'utf8'); } catch (x) { return { err: `cannot read ${path}: ${x.code || x.message}` }; }
  const lines = txt.split('\n'), from = start || 1, to = end || lines.length;
  const slice = lines.slice(from - 1, to);
  return { out: slice.map((l, i) => String(from + i).padStart(5) + '  ' + l).join('\n'), lines: slice.length, total: lines.length };
}
function toolList(arg) {
  const dir = arg || '.';
  let ents; try { ents = readdirSync(abspath(dir), { withFileTypes: true }); } catch (x) { return { err: `cannot list ${dir}: ${x.code || x.message}` }; }
  const names = ents.filter(e => !e.name.startsWith('.'))
    .sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name))
    .map(e => e.isDirectory() ? e.name + '/' : e.name);
  return { out: names.join('\n') || '(empty)' };
}
function toolSearch(arg) {
  const cmd = `(command -v rg >/dev/null && rg -n --no-heading -S --max-count 6 -- ${shq(arg)} . || grep -rnI -- ${shq(arg)} . ) 2>/dev/null | head -40`;
  return { out: sh(cmd).trim() || '(no matches)' };
}
// strip a line-number gutter the model may have copied from a `read` ("   12  code")
const degut = (s) => s.split('\n').map(l => l.replace(/^\s*\d+\s{2}/, '')).join('\n');
// locate SEARCH in the file tolerantly (exact → de-guttered → per-line whitespace-flexible)
function locate(txt, oldStr, newStr) {
  const uniq = (o, n) => { const i = txt.indexOf(o); return (i >= 0 && txt.indexOf(o, i + 1) < 0) ? { txt: txt.slice(0, i) + n + txt.slice(i + o.length), line: txt.slice(0, i).split('\n').length } : null; };
  let r = uniq(oldStr, newStr); if (r) return r;
  const og = degut(oldStr); if (og !== oldStr) { r = uniq(og, degut(newStr)); if (r) return r; }
  const F = txt.split('\n'), O = og.split('\n').map(l => l.replace(/\s+$/, '')), N = degut(newStr).split('\n');
  const norm = (l) => l.replace(/\s+$/, '');
  let at = -1, count = 0;
  for (let i = 0; i + O.length <= F.length; i++) {
    let ok = true; for (let j = 0; j < O.length; j++) if (norm(F[i + j]) !== O[j]) { ok = false; break; }
    if (ok) { count++; if (at < 0) at = i; }
  }
  if (count === 1) return { txt: [...F.slice(0, at), ...N, ...F.slice(at + O.length)].join('\n'), line: at + 1 };
  if (count > 1) return { dup: count };
  return null;
}
function toolEdit(path, body) {
  const m = body.match(/<{3,}\s*SEARCH\s*\n([\s\S]*?)\n={3,}\s*\n([\s\S]*?)\n>{3,}\s*REPLACE/);
  if (!m) return { err: 'malformed edit block. use <<<<<<< SEARCH / ======= / >>>>>>> REPLACE' };
  const oldStr = m[1], newStr = m[2];
  let txt; try { txt = readFileSync(abspath(path), 'utf8'); } catch (x) { return { err: `cannot read ${path}: ${x.code || x.message}` }; }
  const loc = locate(txt, oldStr, newStr);
  if (!loc) return { err: `SEARCH text not found in ${path}. Re-read the file and copy the exact lines WITHOUT the line-number prefix.` };
  if (loc.dup) return { err: `SEARCH matches ${loc.dup}x in ${path}. Add more surrounding context to make it unique.` };
  writeFileSync(abspath(path), loc.txt);
  const oldL = degut(oldStr).split('\n'), newL = degut(newStr).split('\n'), rows = [];
  oldL.forEach((l, i) => rows.push(c.gry(String(loc.line + i).padStart(5)) + ' ' + c.red('- ' + l)));
  newL.forEach((l, i) => rows.push(c.gry(String(loc.line + i).padStart(5)) + ' ' + c.grn('+ ' + l)));
  return { out: `Updated ${path} (+${newL.length} -${oldL.length})`, rows };
}
function toolWrite(path, body) {
  const existed = existsSync(abspath(path));
  try { mkdirSync(dirname(abspath(path)), { recursive: true }); writeFileSync(abspath(path), body.endsWith('\n') ? body : body + '\n'); }
  catch (x) { return { err: `cannot write ${path}: ${x.code || x.message}` }; }
  return { out: `${existed ? 'Overwrote' : 'Created'} ${path} (${body.split('\n').length} lines)` };
}

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
const READONLY = new Set(['read', 'list', 'search']);
const LABELS = { read: 'Read', list: 'List', search: 'Search', edit: 'Update', write: 'Write', run: 'Run' };
async function runTask(task, history) {
  console.log('');
  history.push({ role: 'user', content: task });
  let ran = false;
  for (let step = 1; step <= MAX_STEPS; step++) {
    const reply = await think(history.map(m => ({ ...m, content: redact(m.content) })));
    history.push({ role: 'assistant', content: reply });
    const act = parseAction(reply);
    if (!act) break;                        // no action -> done / just talking
    const { verb, arg } = act;
    if (verb === 'done') { ran = true; break; }
    const path0 = arg.split(/\s+/)[0] || '';
    const shown = verb === 'search' ? arg : (verb === 'run' ? (arg || act.body.split('\n')[0]) : path0);
    console.log(`${MARK} ${c.b(LABELS[verb])}${c.gry('(')}${c.gry(shown)}${c.gry(')')}`);

    // permission: reads auto-run; edits/writes/run + anything out-of-bounds ask
    const oob = verb === 'run' ? outOfBounds(arg || act.body) : (within(path0) ? [] : [path0]);
    let ok = true;
    if (oob.length) ok = await permit(LABELS[verb], shown, `⚠ this touches files OUTSIDE the project: ${oob.join(', ')}`);
    else if (!READONLY.has(verb)) ok = await permit(LABELS[verb], shown);
    if (!ok) { console.log(`  ${c.gry('⎿')}  ${c.red('denied by user')}`); history.push({ role: 'user', content: `The user denied ${verb} on ${shown}. Try another approach inside the project.` }); continue; }

    // execute the tool locally
    let res, obs;
    if (verb === 'read') { res = toolRead(arg); obs = res.err || `${path0} (${res.lines}/${res.total} lines):\n${res.out}`; }
    else if (verb === 'list') { res = toolList(arg); obs = res.err || `${arg || '.'}:\n${res.out}`; }
    else if (verb === 'search') { res = toolSearch(arg); obs = res.err || `matches for "${arg}":\n${res.out}`; }
    else if (verb === 'edit') { res = toolEdit(path0, act.body); obs = res.err || res.out; if (!res.err) ran = true; }
    else if (verb === 'write') { res = toolWrite(path0, act.body); obs = res.err || res.out; if (!res.err) ran = true; }
    else { const cmd = arg || act.body; const out = sh(cmd); res = { out }; obs = `$ ${cmd}\n${clip(out, 3000)}`; ran = true; }

    // render result under the action
    if (res.err) console.log(`  ${c.gry('⎿')}  ${c.red(res.err.split('\n')[0])}`);
    else if (res.rows) { console.log(`  ${c.gry('⎿')}  ${c.dim(res.out)}`); for (const row of res.rows.slice(0, 30)) console.log('     ' + row); }
    else { const lines = clip(res.out, 600).split('\n'); console.log(`  ${c.gry('⎿')}  ${c.dim(lines[0] || '(empty)')}`); for (const l of lines.slice(1, 8)) console.log('     ' + c.dim(l)); }
    console.log('');
    history.push({ role: 'user', content: redact(clip(obs, 4000)) });
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
    if (task === '/help') { console.log(c.dim('  describe a coding task; I locate, read, edit, and run tests to verify.\n  reads auto-run · edits/commands ask first · files outside this dir always ask.\n  /login set key · /exit quit')); continue; }
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

WORKING ON A TASK — begin immediately. Do NOT greet, introduce yourself, or restate your identity;
just start working. You act as an agent in a loop. Each turn: write ONE short sentence on what
you're doing next, then emit EXACTLY ONE action as a fenced code block. The first line inside the
block is the command. You get the result next turn, then continue. One action per turn only.

Actions (the first line is literally the command):

\`\`\`
list src
\`\`\`
List files in a directory (default: the repo root).

\`\`\`
search <regex>
\`\`\`
Search file contents across the repo. Use this to locate code before reading.

\`\`\`
read path/to/file.py 20 60
\`\`\`
Read a file. The two numbers (optional) are a start/end line range.

\`\`\`
edit path/to/file.py
<<<<<<< SEARCH
the exact existing text to replace
=======
the new text
>>>>>>> REPLACE
\`\`\`
Replace an exact, unique snippet. The SEARCH text must match the file's lines including indentation.
Copy it from a read, but do NOT include the line-number prefix — only the code itself. Keep edits
small and surgical.

\`\`\`
write path/to/new_file.py
<full file contents>
\`\`\`
Create a new file or fully overwrite one. Prefer edit for existing files.

\`\`\`
run python3 -m pytest -q
\`\`\`
Run a shell command (tests, build, repro).

\`\`\`
done
one line on what you changed
\`\`\`
Finish — ONLY after you verified the fix (ran the test/repro and it passed).

Discipline (this is what makes you good):
- First locate the relevant code with list/search, then READ a file before you edit it.
- Make the SMALLEST change that solves the task. Never edit or reformat unrelated code.
- After an edit, run the test or repro. If it fails, read the error and iterate.
- Finish with \`done\` as soon as it's verified. Do not keep poking once it works.`;

main();

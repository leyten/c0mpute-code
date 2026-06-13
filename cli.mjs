#!/usr/bin/env node
// c0mpute code — decentralized coding agent.
// The brain runs on the c0mpute network (the "code" model, Devstral); file edits
// and commands run locally on your machine, under your approval. No single company
// can take it down, rate-limit it, or censor it.
//
//   C0MPUTE_API_KEY=sk-... c0mpute-code            # interactive
//   C0MPUTE_API_KEY=sk-... c0mpute-code "task"     # one task, then exit
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { createInterface } from 'readline';
import { stdin, stdout } from 'process';

// ── config ──
const API = (process.env.C0MPUTE_API_URL || 'https://c0mpute.ai/api/v1') + '/chat/completions';
const KEY = process.env.C0MPUTE_API_KEY;
const MODEL = process.env.C0MPUTE_MODEL || 'code';
const MAX_STEPS = Number(process.env.C0MPUTE_MAX_STEPS || 40);
const CWD = process.cwd();
const AUTO = process.env.C0MPUTE_YOLO === '1';

// ── ansi ──
const e = (n) => (s) => `\x1b[${n}m${s}\x1b[0m`;
const c = { dim: e(2), bold: e(1), red: e(31), grn: e(32), yel: e(33), blu: e(34), cyn: e(36), mag: e(35), gry: e(90), b: (s) => `\x1b[1m${s}\x1b[0m` };
const ACCENT = (s) => `\x1b[38;5;208m${s}\x1b[0m`; // c0mpute orange-ish
const vlen = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').length;
const clip = (s, n = 4000) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + c.dim(` … +${s.length - n} chars`) : s; };

// ── rounded box ──
const W = 70;
function box(lines) {
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
  if (/(?:\bsed\s+-i\b|>\s*\S|\btee\b|>>)/.test(cmd) || /^cat\s*>/.test(first)) { const f = (cmd.match(/>\s*([^\s&|;]+)/) || cmd.match(/\bsed\s+-i\b.*?\s([^\s&|;]+)\s*$/) || [])[1]; return { verb: 'Update', arg: f || '', write: true }; }
  return { verb: 'Bash', arg: first, write: false };
}

// ── streaming over the network ──
const WORDS = ['Brewing', 'Computing', 'Routing', 'Reasoning', 'Crunching', 'Distributing'];
async function think(messages) {
  let i = 0, tick = null, first = false; const word = WORDS[Math.floor(messages.length) % WORDS.length];
  if (stdout.isTTY) tick = setInterval(() => { if (!first) process.stdout.write(`\r${ACCENT('✻')} ${c.dim(word + '… (the brain is on the c0mpute network)')}   `); }, 90);
  const stop = () => { if (tick) { clearInterval(tick); tick = null; if (stdout.isTTY) process.stdout.write('\r\x1b[K'); } };
  try {
    const r = await fetch(API, { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: MODEL, messages, temperature: 0.2, max_tokens: 1024, stream: true }) });
    if (!r.ok) throw new Error(`c0mpute API ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = '', full = '', inCode = false, shown = false;
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true }); const lines = buf.split('\n'); buf = lines.pop() || '';
      for (const ln of lines) {
        if (!ln.startsWith('data:')) continue; const p = ln.slice(5).trim(); if (p === '[DONE]') continue;
        let tok = ''; try { tok = JSON.parse(p).choices?.[0]?.delta?.content || ''; } catch { continue; }
        if (!tok) continue;
        if (!first) { first = true; stop(); }
        full += tok;
        if (!inCode) { if (full.includes('```')) inCode = true; else { process.stdout.write(tok.replace(/THOUGHT:?\s*/i, '').replace(/\n/g, '\n')); shown = true; } }
      }
    }
    if (shown) process.stdout.write('\n');
    return full;
  } finally { stop(); }
}
const parseCmd = (t) => { const m = String(t || '').match(/```(?:bash|sh)?\s*\n([\s\S]*?)```/); return m ? m[1].trim() : null; };

// ── permission (Claude-style) ──
const allow = { all: AUTO }; const session = new Set();
const ask = (q) => new Promise(r => { const rl = createInterface({ input: stdin, output: stdout }); rl.question(q, a => { rl.close(); r(a.trim()); }); });
async function permit(verb, detail) {
  if (allow.all || session.has(verb)) return true;
  console.log('\n' + box([c.b(verb + ' wants to run:'), '', c.yel(detail.slice(0, W - 8))]));
  const a = (await ask(`  ${c.b('1.')} yes   ${c.b('2.')} yes, don't ask again for ${verb}   ${c.b('3.')} no  › `)).toLowerCase();
  if (a === '2') { session.add(verb); return true; }
  return a === '1' || a === 'y' || a === '';
}

// ── one task ──
async function runTask(task, history) {
  console.log('\n' + c.b('> ') + task + '\n');
  history.push({ role: 'user', content: task });
  for (let step = 1; step <= MAX_STEPS; step++) {
    const reply = await think(history.map(m => ({ ...m, content: redact(m.content) })));
    history.push({ role: 'assistant', content: reply });
    const cmd = parseCmd(reply);
    if (!cmd) break;
    if (cmd.trim() === 'echo C0MPUTE_DONE') break;
    const { verb, arg, write } = label(cmd);
    console.log(`${c.grn('●')} ${c.b(verb)}${c.gry('(')}${c.gry(arg || cmd.split('\n')[0])}${c.gry(')')}`);
    if (!isSafe(cmd) && !(await permit(verb, cmd.split('\n')[0]))) {
      console.log(`  ${c.gry('⎿')}  ${c.red('denied by user')}`);
      history.push({ role: 'user', content: 'The user DENIED that command. Try another approach.' }); continue;
    }
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
  console.log(c.grn('●') + ' ' + c.dim('done') + '\n');
}

// ── main ──
async function main() {
  if (!KEY) { console.error(c.red('set C0MPUTE_API_KEY (get one at c0mpute.ai)')); process.exit(1); }
  console.log('\n' + box([
    `${ACCENT('✻')} ${c.b('c0mpute code')}`,
    c.dim('decentralized coding agent — brain on the network, hands local'),
    '',
    `${c.dim('model:')} ${MODEL}    ${c.dim('cwd:')} ${CWD.replace(process.env.HOME || '~', '~')}`,
    isGit ? c.dim('git repo · diffs on') : c.dim('not a git repo · diffs off'),
  ]));
  const history = [{ role: 'system', content: SYSTEM }];
  const fin = () => { if (redactCount) console.log(c.dim(`  ${redactCount} secret${redactCount > 1 ? 's' : ''} redacted before leaving your machine`)); };
  const one = process.argv.slice(2).join(' ').trim();
  if (one) { await runTask(one, history); fin(); return; }
  while (true) {
    console.log(c.gry('╭' + '─'.repeat(W - 2) + '╮') + '\n' + c.gry('│ ') + c.b('> ') + ' '.repeat(W - 6) + c.gry('│') + '\n' + c.gry('╰' + '─'.repeat(W - 2) + '╯'));
    const task = await ask('  ');
    if (!task) continue;
    if (task === '/exit' || task === '/quit') { fin(); break; }
    if (task === '/help') { console.log(c.dim('  type a coding task. commands ask approval; reads auto-run. /exit to quit.')); continue; }
    try { await runTask(task, history); } catch (x) { console.log(c.red('  ! ' + x.message)); }
  }
}

const SYSTEM = `You are c0mpute code, an autonomous coding agent in a local repo at ${CWD}.
Each turn: a brief THOUGHT (1-2 sentences), then exactly ONE bash command in a single \`\`\`bash code block.
The command runs in the repo; you get stdout/stderr next turn. Work in small steps: explore (ls/cat/grep),
edit (sed -i, or cat > path <<'EOF' … EOF), and run tests to verify. Do not ask the user questions.
When the task is fully complete, output a THOUGHT then exactly:
\`\`\`bash
echo C0MPUTE_DONE
\`\`\``;

main();

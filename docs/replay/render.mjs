// Puts the recorded review (docs/replay/reviewproof.jsonl, from record.sh) into docs/index.html,
// between <!-- replay:log --> and <!-- /replay:log -->, and the final numbers into the meters.
//   node docs/replay/render.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const page = path.join(here, '..', 'index.html');
const steps = fs.readFileSync(path.join(here, 'reviewproof.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const attr = (o) => Object.entries(o).map(([k, v]) => ` data-${k}="${esc(String(v))}"`).join('');

// Which part of the review (the list beside the log) a step belongs to.
let stage = 0;
function stageOf(cmd, round) {
  if (round === 2) return 5;
  if (cmd.startsWith('gate:')) return 4;
  if (/gate run/.test(cmd)) return 1;
  if (/findings|reviewproof add|verdict/.test(cmd)) return 2;
  if (/draft|post/.test(cmd)) return 3;
  return 0;
}

// The meters after each step, read from what the commands printed.
const m = {};
let open = 0;
const lines = [];
for (const s of steps) {
  const out = s.out.split(/\r?\n/);
  const text = out.join('\n');
  const round = Number(text.match(/^round (\d+) of /m)?.[1] ?? m.round ?? 1);
  if (/^round \d+ of /m.test(text)) m.round = round;
  const gate = text.match(/^gate \S+ attempt \d+: (\w+)/m)?.[1];
  if (gate) m.gate = gate;
  open += (text.match(/^added F/gm) ?? []).length - (text.match(/: verified in round/g) ?? []).length;
  if (s.cmd.startsWith('reviewproof add') || /verified in round/.test(text)) m.open = open;
  const verdict = text.match(/^round \d+: (pass|not-yet)/m)?.[1] ?? (/^verdict \S+ refused/m.test(text) ? 'refused' : undefined);
  if (verdict) m.verdict = verdict;
  stage = stageOf(s.cmd, m.round);
  const isGate = s.cmd.startsWith('gate:');
  const shown = isGate ? `# ${s.cmd.slice(5).trim()}` : s.cmd.startsWith('#') ? s.cmd : `$ ${s.cmd}`;
  const kind = isGate ? 'ln note gate' : s.cmd.startsWith('#') ? 'ln note' : 'ln cmd';
  lines.push(`<span class="${kind}"${attr({ step: stage, sec: s.sec, ...m })}>${esc(shown)}</span>`);
  for (const l of s.out ? out : []) lines.push(`<span class="ln">${esc(l)}</span>`);
}

const html = fs.readFileSync(page, 'utf8');
const log = `<!-- replay:log --><pre class="rp-log" id="rp-log" tabindex="0">${lines.join('')}</pre><!-- /replay:log -->`;
let out = html.replace(/<!-- replay:log -->[\s\S]*?<!-- \/replay:log -->/, log);
for (const [k, v] of Object.entries(m)) out = out.replace(new RegExp(`(<span id="rp-${k}">)[^<]*(</span>)`), `$1${v}$2`);
const total = steps.reduce((n, s) => n + s.sec, 0);
// In the English markup and in the Vietnamese string of the language switch.
out = out.replace(/(<span id="rp-total">)[^<]*(<\/span>)/g, `$1${total}$2`);
fs.writeFileSync(page, out);
console.log(`${lines.length} lines, ${total} s of real time; meters ${JSON.stringify(m)}`);

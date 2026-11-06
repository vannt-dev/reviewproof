import fs from 'node:fs';
import { renderDraft } from '../draft.ts';
import { sameNote } from '../hosts.ts';
import { currentStatus } from '../rounds.ts';
import { verdictBlockers } from '../verdict.ts';
import {
  assertHead, bullets, coverageOf, openForChange, openReview, prName, str, take, type Command,
} from './context.ts';

const verdict: Command = {
  args: '<pass|not-yet> --summary S',
  about: 'record the verdict once nothing blocks it; commits the ledger',
  options: { summary: { type: 'string' } },
  async run(env, a) {
    const [value] = take(a, '<pass|not-yet>');
    if (value !== 'pass' && value !== 'not-yet') throw new Error('the verdict is pass or not-yet');
    const r = openForChange(env);
    await assertHead(env, r);
    const summary = (str(a, 'summary') ?? '').trim();
    const blockers = verdictBlockers(r.ledger, coverageOf(env, r), r.config, value, summary);
    if (blockers.length > 0) {
      console.error(`verdict ${value} refused:\n${bullets(blockers)}`);
      return 1;
    }
    r.round.verdict = { value, summary, at: env.now().toISOString() };
    // A draft from before this verdict is stale even within the same millisecond.
    delete r.round.draftAt;
    env.store.save(r.ledger);
    // Open = still to be fixed: never verified or withdrawn, or reopened.
    const open = r.ledger.findings.filter((f) => ['open', 'reopened'].includes(currentStatus(f))).length;
    env.store.commit(`${prName(r.ref)} round ${r.round.n}: ${value}, ${open} open`);
    console.log(`round ${r.round.n}: ${value}, ${open} open; next: reviewproof draft`);
    return 0;
  },
};

const draft: Command = {
  args: '',
  about: 'write the round note and print it for the person to read',
  async run(env, a) {
    take(a);
    const r = openForChange(env);
    const md = renderDraft(r.ledger, coverageOf(env, r));
    const file = env.store.writeDraft(r.ref, r.round.n, md);
    r.round.draftAt = env.now().toISOString();
    env.store.save(r.ledger);
    console.log(`${file}\n\n${md}`);
    return 0;
  },
};

// sameNote's normalisation, line by line, so the warning shows where the texts part.
function firstDifference(sent: string, back: string): string {
  const lines = (t: string): string[] => t.replace(/\r\n/g, '\n').split('\n').map((l) => l.trimEnd());
  const a = lines(sent);
  const b = lines(back);
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return `line ${i + 1}:\n  draft:  ${a[i] ?? '(end)'}\n  posted: ${b[i] ?? '(end)'}`;
}

const post: Command = {
  args: '--approved-by NAME',
  about: 'post the draft and read it back (the person runs this, never the agent)',
  options: { 'approved-by': { type: 'string' } },
  async run(env, a) {
    take(a);
    const approvedBy = (str(a, 'approved-by') ?? '').trim();
    if (approvedBy === '') throw new Error('post needs --approved-by <name of the person who read the draft>');
    const r = openReview(env);
    const { round } = r;
    if (round.post) throw new Error(`round ${round.n} is already posted: ${round.post.url}`);
    const v = round.verdict;
    if (!v) throw new Error(`round ${round.n} has no verdict: run reviewproof verdict first`);
    const file = env.store.draftFile(r.ref, round.n);
    if (!fs.existsSync(file)) throw new Error(`round ${round.n} has no draft: run reviewproof draft`);
    if (!round.draftAt || round.draftAt < v.at) throw new Error('the draft is older than the verdict: run reviewproof draft');
    // The note states this verdict, so it must still hold for the ledger as it is now.
    const blockers = verdictBlockers(r.ledger, coverageOf(env, r), r.config, v.value, v.summary);
    if (blockers.length > 0) {
      console.error(`the ledger changed since the verdict: run reviewproof verdict again\n${bullets(blockers)}`);
      return 1;
    }
    await assertHead(env, r);
    const body = fs.readFileSync(file, 'utf8');
    const host = env.host(r.ref);
    const { id, url } = await host.comment(r.ref, body);
    // Recorded before the read-back: the comment exists either way, and a re-run must not post twice.
    round.post = { id, url, approvedBy, at: env.now().toISOString() };
    env.store.save(r.ledger);
    env.store.commit(`${prName(r.ref)} round ${round.n}: posted`);
    console.log(`posted ${url}`);
    const back = await host.readComment(r.ref, id);
    if (sameNote(body, back)) return 0;
    console.error(`warning: the posted note differs from the draft at ${firstDifference(body, back)}`);
    return 1;
  },
};

export const finish: Record<string, Command> = { verdict, draft, post };

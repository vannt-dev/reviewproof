import fs from 'node:fs';
import { renderDraft } from '../draft.ts';
import { sameNote } from '../hosts.ts';
import { currentStatus } from '../rounds.ts';
import type { Round } from '../types.ts';
import { verdictBlockers } from '../verdict.ts';
import {
  assertOpen, bullets, coverageOf, locked, openReview, prName, str, take, type Command, type Env, type Review,
} from './context.ts';

// A verdict and a post speak about one head; a push since the round started makes both stale.
async function assertHead(env: Env, r: Review): Promise<void> {
  const pr = await env.host(r.ref).resolve(r.ref);
  if (pr.head.toLowerCase() !== r.round.head.toLowerCase()) {
    throw new Error(
      `head moved: the PR is at ${pr.head}, round ${r.round.n} reviewed ${r.round.head}; ` +
        `start the next round with reviewproof start ${r.ledger.pr.url}`,
    );
  }
}

const verdict: Command = {
  args: '<pass|not-yet> --summary S',
  about: 'record the verdict once nothing blocks it; commits the ledger',
  options: { summary: { type: 'string' } },
  async run(env, a) {
    const [value] = take(a, '<pass|not-yet>');
    if (value !== 'pass' && value !== 'not-yet') throw new Error('the verdict is pass or not-yet');
    const seen = assertOpen(openReview(env));
    await assertHead(env, seen);
    const summary = (str(a, 'summary') ?? '').trim();
    // Checked and recorded in one turn of the lock: a change landing meanwhile is seen, not lost.
    return locked(env, seen, (r) => {
      const blockers = verdictBlockers(assertOpen(r).ledger, coverageOf(env, r), r.config, value, summary);
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
    });
  },
};

const draft: Command = {
  args: '',
  about: 'write the round note and print it for the person to read',
  async run(env, a) {
    take(a);
    return locked(env, openReview(env), (r) => {
      const md = renderDraft(assertOpen(r).ledger, coverageOf(env, r));
      const file = env.store.writeDraft(r.ref, r.round.n, md);
      r.round.draftAt = env.now().toISOString();
      env.store.save(r.ledger);
      console.log(`${file}\n\n${md}`);
      return 0;
    });
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
    // Claude Code sets CLAUDECODE=1 in the commands it runs: the person posts, never the agent.
    if (process.env.CLAUDECODE === '1') throw new Error('post from your own terminal, not from the agent');
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
    // Read once, before the checks: the note checked here is the note sent.
    const body = fs.readFileSync(file, 'utf8');
    if (!round.draftAt || round.draftAt < v.at) throw new Error('the draft is older than the verdict: run reviewproof draft');
    const cov = coverageOf(env, r);
    // A draft edited by hand would post claims the ledger does not hold.
    if (!sameNote(renderDraft(r.ledger, cov), body)) throw new Error('the draft file differs from the ledger: run reviewproof draft');
    // The note states this verdict, so it must still hold for the ledger as it is now.
    const blockers = verdictBlockers(r.ledger, cov, r.config, v.value, v.summary);
    if (blockers.length > 0) {
      console.error(`the ledger changed since the verdict: run reviewproof verdict again\n${bullets(blockers)}`);
      return 1;
    }
    await assertHead(env, r);
    const host = env.host(r.ref);
    const { id, url } = await host.comment(r.ref, body);
    // Recorded before the read-back: the comment exists either way, and a re-run must not post twice.
    const changed = record(env, r, v, { id, url, approvedBy, at: env.now().toISOString() });
    console.log(`posted ${url}`);
    if (changed.length > 0) {
      console.error(`posted note is stale: ${url} — the ledger changed while posting\n${bullets(changed)}`);
    }
    const back = await host.readComment(r.ref, id);
    if (sameNote(body, back)) return changed.length > 0 ? 1 : 0;
    console.error(`warning: the posted note differs from the draft at ${firstDifference(body, back)}`);
    return 1;
  },
};

// The host call ran outside the lock: the post goes into the ledger as it is now, and whatever
// changed meanwhile, so that the note no longer states the ledger, is returned.
function record(env: Env, seen: Review, v: NonNullable<Round['verdict']>, post: NonNullable<Round['post']>): string[] {
  try {
    return env.store.locked(seen.ref, () => {
      const l = env.store.load(seen.ref);
      const now = l?.rounds.find((x) => x.n === seen.round.n);
      if (!l || !now) throw new Error(`round ${seen.round.n} is gone from the ledger`);
      if (now.post) throw new Error(`round ${now.n} was posted meanwhile at ${now.post.url}: delete one of the notes`);
      const changed = [
        ...(now.verdict?.at === v.at ? [] : ['the verdict was cleared or recorded again']),
        ...(now.draftAt === seen.round.draftAt ? [] : ['the draft was written again']),
        ...verdictBlockers(l, coverageOf(env, { ...seen, ledger: l, round: now }), seen.config, v.value, v.summary),
      ];
      now.post = post;
      env.store.save(l);
      env.store.commit(`${prName(seen.ref)} round ${now.n}: posted`);
      return changed;
    });
  } catch (e) {
    // The note is out there: without its URL a re-run would post it a second time.
    throw new Error(`posted ${post.url}, but recording it failed: ${(e as Error).message}; do not post again`);
  }
}

export const finish: Record<string, Command> = { verdict, draft, post };

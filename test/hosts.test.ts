import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { hostFor, parsePrRef, sameNote } from '../src/hosts.ts';
import { GitHub } from '../src/github.ts';
import { GitLab } from '../src/gitlab.ts';
import type { PrRef } from '../src/types.ts';

test('parsePrRef: the four forms', () => {
  assert.deepEqual(parsePrRef('https://github.com/o/r/pull/12'), {
    host: 'github', hostname: 'github.com', project: 'o/r', number: 12,
  });
  assert.equal(parsePrRef('https://github.com/o/r/pull/12/files').number, 12);
  assert.deepEqual(parsePrRef('o/r#12'), { host: 'github', hostname: 'github.com', project: 'o/r', number: 12 });
  assert.deepEqual(parsePrRef('https://gitlab.example.com:8443/g/sub/r/-/merge_requests/7'), {
    host: 'gitlab', hostname: 'gitlab.example.com:8443', project: 'g/sub/r', number: 7,
  });
  assert.deepEqual(parsePrRef('gitlab:g/r!7'), { host: 'gitlab', hostname: 'gitlab.com', project: 'g/r', number: 7 });
});

test('parsePrRef: GitHub Enterprise host', () => {
  assert.deepEqual(parsePrRef('https://ghe.corp.io/o/r/pull/3'), {
    host: 'github', hostname: 'ghe.corp.io', project: 'o/r', number: 3,
  });
});

test('parsePrRef: rejects junk, empty and .. segments, listing the accepted forms', () => {
  assert.throws(() => parsePrRef('nonsense'), /o\/r#12/);
  assert.throws(() => parsePrRef('o\\x/r#12'), /invalid project/);
  assert.throws(() => parsePrRef('gitlab:g/r:x!7'), /invalid project/);
  assert.throws(() => parsePrRef('https://example.com/x'), /merge_requests/);
  assert.throws(() => parsePrRef('gitlab:g//r!7'), /project/);
  assert.throws(() => parsePrRef('https://gitlab.com/g/../r/-/merge_requests/7'), /project/);
  assert.throws(() => parsePrRef('o/../x#1'), /project/);
});

test('sameNote ignores CRLF and trailing whitespace only', () => {
  assert.equal(sameNote('a\r\nb  \n', 'a\nb\n'), true);
  assert.equal(sameNote('a', 'b'), false);
  assert.equal(sameNote('a\n b', 'a\nb'), false);
});

const gh: PrRef = { host: 'github', hostname: 'github.com', project: 'o/r', number: 12 };

test('GitHub resolve maps the pull request', async () => {
  const calls: string[][] = [];
  const host = new GitHub((argv) => {
    calls.push(argv);
    return JSON.stringify({ html_url: 'U', title: 'T', head: { sha: 'h1' }, base: { sha: 'b1' } });
  });
  assert.deepEqual(await host.resolve(gh), { url: 'U', title: 'T', head: 'h1', base: 'b1' });
  assert.deepEqual(calls[0], ['api', 'repos/o/r/pulls/12']);
});

test('GitHub adds --hostname for Enterprise', async () => {
  const calls: string[][] = [];
  const host = new GitHub((argv) => {
    calls.push(argv);
    return JSON.stringify({ body: 'x' });
  });
  await host.readComment({ ...gh, hostname: 'ghe.corp.io' }, '5');
  assert.deepEqual(calls[0], ['api', '--hostname', 'ghe.corp.io', 'repos/o/r/issues/comments/5']);
});

test('GitHub comment sends UTF-8 JSON through a temp file and removes it', async () => {
  let file = '';
  let content = '';
  const host = new GitHub((argv) => {
    assert.deepEqual(argv.slice(0, 4), ['api', '-X', 'POST', 'repos/o/r/issues/12/comments']);
    assert.equal(argv[4], '--input');
    file = argv[5] ?? '';
    content = fs.readFileSync(file, 'utf8');
    return JSON.stringify({ id: 99, html_url: 'https://x/c99' });
  });
  const r = await host.comment(gh, 'レビュー chưa đạt');
  assert.deepEqual(r, { id: '99', url: 'https://x/c99' });
  assert.equal((JSON.parse(content) as { body: string }).body, 'レビュー chưa đạt');
  assert.equal(fs.existsSync(file), false);
});

test('GitHub comment removes the temp file when the runner throws', async () => {
  let file = '';
  const host = new GitHub((argv) => {
    file = argv[5] ?? '';
    throw new Error('gh failed');
  });
  await assert.rejects(host.comment(gh, 'b'), /gh failed/);
  assert.equal(fs.existsSync(file), false);
});

const gl: PrRef = { host: 'gitlab', hostname: 'gitlab.example.com', project: 'g/sub/r', number: 7 };

function fakeFetch(reply: unknown, status = 200) {
  const seen: { url: string; init?: RequestInit }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    seen.push({ url, init });
    return new Response(typeof reply === 'string' ? reply : JSON.stringify(reply), { status });
  }) as unknown as typeof fetch;
  return { f, seen };
}

test('GitLab resolve URL-encodes the project and sends the token', async () => {
  const { f, seen } = fakeFetch({ web_url: 'W', title: 'T', diff_refs: { head_sha: 'h', base_sha: 'b' } });
  const info = await new GitLab(f, 'tok').resolve(gl);
  assert.deepEqual(info, { url: 'W', title: 'T', head: 'h', base: 'b' });
  assert.equal(seen[0]?.url, 'https://gitlab.example.com/api/v4/projects/g%2Fsub%2Fr/merge_requests/7');
  assert.equal((seen[0]?.init?.headers as Record<string, string>)['PRIVATE-TOKEN'], 'tok');
});

test('GitLab comment posts a JSON body and builds the note URL', async () => {
  const { f, seen } = fakeFetch({ id: 55 });
  const r = await new GitLab(f, 'tok').comment(gl, 'レビュー');
  assert.deepEqual(r, { id: '55', url: 'https://gitlab.example.com/g/sub/r/-/merge_requests/7#note_55' });
  assert.equal(seen[0]?.init?.method, 'POST');
  assert.equal((seen[0]?.init?.headers as Record<string, string>)['content-type'], 'application/json; charset=utf-8');
  assert.equal((JSON.parse(String(seen[0]?.init?.body)) as { body: string }).body, 'レビュー');
});

test('GitLab readComment returns the body', async () => {
  const { f, seen } = fakeFetch({ body: 'hi' });
  assert.equal(await new GitLab(f, 'tok').readComment(gl, '55'), 'hi');
  assert.ok(seen[0]?.url.endsWith('/merge_requests/7/notes/55'));
});

test('GitLab errors: missing token, non-2xx without leaking the token', async () => {
  const saved = process.env.GITLAB_TOKEN;
  delete process.env.GITLAB_TOKEN;
  try {
    await assert.rejects(new GitLab(fakeFetch({}).f).resolve(gl), /GITLAB_TOKEN is not set/);
  } finally {
    if (saved !== undefined) process.env.GITLAB_TOKEN = saved;
  }
  const err = await new GitLab(fakeFetch('nope', 403).f, 'sekret').resolve(gl).catch((e: Error) => e);
  assert.match((err as Error).message, /403.*nope/);
  assert.doesNotMatch((err as Error).message, /sekret/);
});

test('hostFor picks the implementation by host', () => {
  assert.ok(hostFor(gh) instanceof GitHub);
  assert.ok(hostFor(gl) instanceof GitLab);
});

test('GitHub updateComment PATCHes the comment through a temp file', async () => {
  let content = '';
  const host = new GitHub((argv) => {
    assert.deepEqual(argv.slice(0, 4), ['api', '-X', 'PATCH', 'repos/o/r/issues/comments/99']);
    content = fs.readFileSync(argv[5] ?? '', 'utf8');
    return JSON.stringify({ id: 99, html_url: 'https://x/c99' });
  });
  assert.deepEqual(await host.updateComment(gh, '99', 'vòng 2'), { id: '99', url: 'https://x/c99' });
  assert.equal((JSON.parse(content) as { body: string }).body, 'vòng 2');
});

test('GitHub updateComment: a deleted comment is null, any other failure throws', async () => {
  const fails = (message: string) => new GitHub(() => {
    throw new Error(message);
  });
  assert.equal(await fails('gh api failed: gh: Not Found (HTTP 404)').updateComment(gh, '99', 'b'), null);
  await assert.rejects(fails('gh api failed: gh: Forbidden (HTTP 403)').updateComment(gh, '99', 'b'), /HTTP 403/);
  await assert.rejects(fails('gh api failed: connection reset').updateComment(gh, '99', 'b'), /connection reset/);
});

test('GitHub inline posts one commenting review at the round head', async () => {
  let payload: Record<string, unknown> = {};
  const host = new GitHub((argv) => {
    assert.deepEqual(argv.slice(0, 4), ['api', '-X', 'POST', 'repos/o/r/pulls/12/reviews']);
    payload = JSON.parse(fs.readFileSync(argv[5] ?? '', 'utf8')) as Record<string, unknown>;
    return JSON.stringify({ id: 7, html_url: 'https://x/r7' });
  });
  const posted: unknown[] = [];
  const comments = [
    { finding: 'F1-1', file: 'src/a.ts', line: 2, body: 'one' },
    { finding: 'F1-2', file: 'src/n.ts', from: 'src/o.ts', line: 5, body: 'two' },
  ];
  await host.inline(gh, { head: 'h1', note: 'https://x/c99', comments }, (p) => posted.push(...p));
  assert.deepEqual(payload, {
    commit_id: 'h1',
    event: 'COMMENT',
    body: 'Findings on their lines; the round note: https://x/c99',
    comments: [
      { path: 'src/a.ts', line: 2, side: 'RIGHT', body: 'one' },
      { path: 'src/n.ts', line: 5, side: 'RIGHT', body: 'two' },
    ],
  });
  assert.deepEqual(posted, [
    { finding: 'F1-1', id: '7', url: 'https://x/r7' },
    { finding: 'F1-2', id: '7', url: 'https://x/r7' },
  ]);
});

// Answers each request with the next reply in turn.
function replies(...list: { status?: number; body: unknown }[]) {
  const seen: { url: string; init?: RequestInit }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    seen.push({ url, init });
    const next = list[seen.length - 1] ?? { status: 500, body: 'no reply left' };
    return new Response(typeof next.body === 'string' ? next.body : JSON.stringify(next.body), { status: next.status ?? 200 });
  }) as unknown as typeof fetch;
  return { f, seen };
}

test('GitLab updateComment PUTs the note; a deleted note is null, other failures throw', async () => {
  const ok = replies({ body: { id: 55 } });
  const r = await new GitLab(ok.f, 'tok').updateComment(gl, '55', 'vòng 2');
  assert.deepEqual(r, { id: '55', url: 'https://gitlab.example.com/g/sub/r/-/merge_requests/7#note_55' });
  assert.equal(ok.seen[0]?.url, 'https://gitlab.example.com/api/v4/projects/g%2Fsub%2Fr/merge_requests/7/notes/55');
  assert.equal(ok.seen[0]?.init?.method, 'PUT');
  assert.equal((JSON.parse(String(ok.seen[0]?.init?.body)) as { body: string }).body, 'vòng 2');

  assert.equal(await new GitLab(replies({ status: 404, body: 'gone' }).f, 'tok').updateComment(gl, '55', 'b'), null);
  await assert.rejects(new GitLab(replies({ status: 403, body: 'no' }).f, 'tok').updateComment(gl, '55', 'b'), /GitLab 403/);
});

const mr = { web_url: 'W', title: 'T', diff_refs: { head_sha: 'h1', base_sha: 'mb', start_sha: 'st' } };

test('GitLab inline opens one discussion per finding at its position in the merge request diff', async () => {
  const { f, seen } = replies(
    { body: mr },
    { body: { id: 'd1', notes: [{ id: 61 }] } },
    { body: { id: 'd2', notes: [{ id: 62 }] } },
  );
  const posted: unknown[] = [];
  const comments = [
    { finding: 'F1-1', file: 'src/a.ts', line: 2, body: 'one' },
    { finding: 'F1-2', file: 'src/n.ts', from: 'src/o.ts', line: 5, body: 'two' },
  ];
  await new GitLab(f, 'tok').inline(gl, { head: 'H1', note: 'N', comments }, (p) => posted.push(...p));
  assert.ok(seen[0]?.url.endsWith('/merge_requests/7'));
  assert.equal(seen[1]?.url, 'https://gitlab.example.com/api/v4/projects/g%2Fsub%2Fr/merge_requests/7/discussions');
  assert.equal(seen[1]?.init?.method, 'POST');
  const sent = seen.slice(1).map((x) => JSON.parse(String(x.init?.body)) as unknown);
  const position = { position_type: 'text', base_sha: 'mb', start_sha: 'st', head_sha: 'h1' };
  assert.deepEqual(sent, [
    { body: 'one', position: { ...position, old_path: 'src/a.ts', new_path: 'src/a.ts', new_line: 2 } },
    { body: 'two', position: { ...position, old_path: 'src/o.ts', new_path: 'src/n.ts', new_line: 5 } },
  ]);
  const url = 'https://gitlab.example.com/g/sub/r/-/merge_requests/7';
  assert.deepEqual(posted, [
    { finding: 'F1-1', id: 'd1', url: `${url}#note_61` },
    { finding: 'F1-2', id: 'd2', url: `${url}#note_62` },
  ]);
});

test('GitLab inline: a refused discussion does not hold up the next; auth failures stop; a moved head is refused', async () => {
  const comments = [
    { finding: 'F1-1', file: 'a', line: 1, body: 'one' },
    { finding: 'F1-2', file: 'b', line: 1, body: 'two' },
    { finding: 'F1-3', file: 'c', line: 1, body: 'three' },
  ];
  const posted: unknown[] = [];
  const partial = replies(
    { body: mr },
    { body: { id: 'd1', notes: [{ id: 61 }] } },
    { status: 400, body: 'line_code invalid' },
    { body: { id: 'd3', notes: [{ id: 63 }] } },
  );
  await assert.rejects(
    new GitLab(partial.f, 'tok').inline(gl, { head: 'h1', note: 'N', comments }, (p) => posted.push(...p)),
    /GitLab refused F1-2: GitLab 400 .*line_code invalid/,
  );
  assert.deepEqual(posted.map((p) => (p as { finding: string }).finding), ['F1-1', 'F1-3']);

  const auth = replies({ body: mr }, { status: 403, body: 'forbidden' });
  await assert.rejects(new GitLab(auth.f, 'tok').inline(gl, { head: 'h1', note: 'N', comments }, () => {}), /GitLab 403/);
  assert.equal(auth.seen.length, 2);

  const moved = replies({ body: mr });
  await assert.rejects(new GitLab(moved.f, 'tok').inline(gl, { head: 'h2', note: 'N', comments }, () => {}), /head moved/);
  assert.equal(moved.seen.length, 1);
});

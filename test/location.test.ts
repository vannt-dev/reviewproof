import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatLocation, isEvidence, parseLocation } from '../src/location.ts';

test('parses file:line@sha', () => {
  assert.deepEqual(parseLocation('src/a.ts:12@abc1234'), {
    file: 'src/a.ts',
    line: 12,
    sha: 'abc1234',
  });
});

test('rejects a missing sha', () => {
  assert.throws(() => parseLocation('src/a.ts:12'), /needs @<sha>/);
});

test('rejects a bad line', () => {
  assert.throws(() => parseLocation('src/a.ts:0@abc1234'), /line/);
  assert.throws(() => parseLocation('src/a.ts:x@abc1234'), /line/);
});

test('rejects a bad sha', () => {
  assert.throws(() => parseLocation('src/a.ts:3@xyz'), /sha/);
  assert.throws(() => parseLocation('src/a.ts:3@abc12'), /sha/);
});

test('rejects non repo-relative files', () => {
  assert.throws(() => parseLocation('C:/x/a.ts:3@abc1234'), /repo-relative/);
  assert.throws(() => parseLocation('/x/a.ts:3@abc1234'), /repo-relative/);
  const backslash = String.fromCharCode(92);
  assert.throws(() => parseLocation('C:' + backslash + 'x.ts:3@abc1234'), /repo-relative/);
});

test('formatLocation round-trips', () => {
  const text = 'src/a.ts:12@abc1234';
  assert.equal(formatLocation(parseLocation(text)), text);
});

test('isEvidence accepts a location or a url, not prose', () => {
  assert.equal(isEvidence('fixed in src/a.ts:3@abc1234'), true);
  assert.equal(isEvidence('see https://example.com/x'), true);
  assert.equal(isEvidence('the author disagrees'), false);
});

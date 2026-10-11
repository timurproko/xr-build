import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { classify, handoff, linkThirdParty, remove, sweep, taskWorktrees, unlinkThirdParty, worktreeName } from './worktree.mjs';

test('a branch is <type>/<short-desc>; the worktree is named after the description', () => {
  assert.equal(worktreeName('fix/hand-jitter'), 'hand-jitter');
  assert.equal(worktreeName('feat/ui-kit-slider2'), 'ui-kit-slider2');
  for (const bad of ['hand-jitter', 'Fix/x', 'fix/Hand', 'wip/x', 'fix/a/b', 'fix/-x']) {
    assert.throws(() => worktreeName(bad), /type/, bad);
  }
});

test('third_party entries are linked, not copied, and unlinking leaves the originals', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-'));
  const from = path.join(tmp, 'primary', 'third_party');
  const to = path.join(tmp, 'wt', 'third_party');
  fs.mkdirSync(path.join(from, 'cef', 'include'), { recursive: true });
  fs.writeFileSync(path.join(from, 'cef', 'include', 'cef.h'), 'header');
  fs.writeFileSync(path.join(from, 'README.md'), 'tracked');
  fs.mkdirSync(to, { recursive: true });
  fs.writeFileSync(path.join(to, 'README.md'), 'tracked');

  assert.deepEqual(linkThirdParty(from, to), ['cef']);
  assert.ok(fs.lstatSync(path.join(to, 'cef')).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(to, 'cef', 'include', 'cef.h'), 'utf8'), 'header');
  assert.deepEqual(linkThirdParty(from, to), [], 'already linked entries are kept');

  assert.deepEqual(unlinkThirdParty(to), ['cef']);
  assert.ok(!fs.existsSync(path.join(to, 'cef')));
  assert.equal(fs.readFileSync(path.join(from, 'cef', 'include', 'cef.h'), 'utf8'), 'header', 'the original is untouched');
  assert.equal(fs.readFileSync(path.join(to, 'README.md'), 'utf8'), 'tracked');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('removing a worktree folder that still holds a junction removes the link, not its target', () => {
  // remove() deletes what git leaves behind with fs.rmSync; a junction left in it must not take the target along.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-'));
  const target = path.join(tmp, 'primary', 'cef');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'libcef.dll'), 'binary');
  const wt = path.join(tmp, 'wt');
  fs.mkdirSync(path.join(wt, 'node_modules'), { recursive: true });
  fs.symlinkSync(target, path.join(wt, 'node_modules', 'cef'), 'junction');
  fs.rmSync(wt, { recursive: true, force: true });
  assert.ok(!fs.existsSync(wt));
  assert.equal(fs.readFileSync(path.join(target, 'libcef.dll'), 'utf8'), 'binary');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('nothing fetched in the primary checkout links nothing', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-'));
  assert.deepEqual(linkThirdParty(path.join(tmp, 'missing'), path.join(tmp, 'wt')), []);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('states: dirty wins, then the PR decides; no PR is active work', () => {
  assert.equal(classify({ dirty: true, pr: 'MERGED' }), 'dirty');
  assert.equal(classify({ dirty: false, pr: 'unknown' }), 'unknown');
  assert.equal(classify({ dirty: false, pr: 'MERGED' }), 'merged');
  assert.equal(classify({ dirty: false, pr: 'CLOSED' }), 'closed');
  assert.equal(classify({ dirty: false, pr: 'OPEN' }), 'active');
  assert.equal(classify({ dirty: false, pr: null }), 'active');
});

/** A primary checkout with one task worktree per given branch under .worktrees/. */
function repoWith(branches) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-repo-'));
  const g = (...a) => execFileSync('git', ['-C', root, ...a], { stdio: 'pipe' }).toString().trim();
  g('init', '--quiet', '-b', 'main');
  fs.writeFileSync(path.join(root, '.gitignore'), '.worktrees/\n.artifacts/\n');
  g('add', '-A');
  g('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '--quiet', '-m', 'init');
  for (const b of branches) g('worktree', 'add', '--quiet', '-b', b, path.join(root, '.worktrees', worktreeName(b)));
  return { root, g };
}

test('sweep lists every task worktree; --apply removes only the merged clean one and its branch', () => {
  const { root, g } = repoWith(['feat/merged', 'feat/dirty', 'feat/open', 'feat/closed', 'feat/unknown', 'feat/dirty-merged']);
  fs.writeFileSync(path.join(root, '.worktrees', 'dirty', 'wip.txt'), 'x');
  fs.writeFileSync(path.join(root, '.worktrees', 'dirty-merged', 'wip.txt'), 'x');
  const states = { 'feat/merged': 'MERGED', 'feat/dirty': 'OPEN', 'feat/open': 'OPEN', 'feat/closed': 'CLOSED', 'feat/unknown': 'unknown', 'feat/dirty-merged': 'MERGED' };
  const prState = (b) => states[b];
  const quiet = () => {};
  const rows = sweep({ root, prState, log: quiet });
  assert.deepEqual(Object.fromEntries(rows.map((r) => [r.name, r.state])), { merged: 'merged', dirty: 'dirty', open: 'active', closed: 'closed', unknown: 'unknown', 'dirty-merged': 'dirty' });
  assert.equal(taskWorktrees(root).length, 6, 'without --apply nothing is removed');

  sweep({ root, prState, apply: true, log: quiet });
  assert.deepEqual(taskWorktrees(root).map((w) => w.name).sort(), ['closed', 'dirty', 'dirty-merged', 'open', 'unknown']);
  assert.ok(!fs.existsSync(path.join(root, '.worktrees', 'merged')));
  assert.equal(g('branch', '--list', 'feat/merged'), '', 'the merged branch is deleted');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a closed PR\'s worktree is removed only with --discard, and --discard refuses an open or merged PR', () => {
  const { root, g } = repoWith(['feat/closed', 'feat/open', 'feat/merged']);
  const states = { 'feat/closed': 'CLOSED', 'feat/open': 'OPEN', 'feat/merged': 'MERGED' };
  const opts = { root, prState: (b) => states[b], log: () => {} };
  assert.throws(() => remove('closed', opts), /closed unmerged: remove it with --discard/);
  assert.throws(() => remove('open', { ...opts, discard: true }), /PR is OPEN/);
  assert.throws(() => remove('merged', { ...opts, discard: true }), /PR is MERGED/);
  remove('closed', { ...opts, discard: true });
  assert.ok(!fs.existsSync(path.join(root, '.worktrees', 'closed')));
  assert.equal(g('branch', '--list', 'feat/closed'), '');
  assert.throws(() => remove('nope', opts), /no worktree/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('handoff records the worktree in .artifacts/handoff.json and returns the report skeleton', () => {
  const { root, g } = repoWith(['feat/thing']);
  const report = handoff('thing', { root, change: 'add-thing', pr: '12', now: new Date('2026-10-11T08:00:00Z') });
  const dir = path.join(root, '.worktrees', 'thing');
  const record = JSON.parse(fs.readFileSync(path.join(dir, '.artifacts', 'handoff.json'), 'utf8'));
  assert.deepEqual({ ...record, worktree: undefined }, { worktree: undefined, branch: 'feat/thing', change: 'add-thing', pr: 12, head: g('rev-parse', 'HEAD'), time: '2026-10-11T08:00:00.000Z' });
  assert.match(report, /^Worktree: .*thing\nBranch and PR: feat\/thing, #12 \(change add-thing\)\nCommit: [0-9a-f]{7}\nCommands run: \nBehaviour: \nGaps: \nManual test: $/);
  assert.equal(execFileSync('git', ['-C', dir, 'status', '--porcelain']).toString(), '', '.artifacts/ is ignored');
  fs.rmSync(root, { recursive: true, force: true });
});

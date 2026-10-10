import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { linkThirdParty, unlinkThirdParty, worktreeName } from './worktree.mjs';

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

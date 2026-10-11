import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { OPENSPEC_BIN } from './finalize.mjs';
import { failureSummary, logTail, planTriage, prBody, scaffold } from './nightly-triage.mjs';
import { parseLink } from './pr-body.mjs';

test('first failure opens a PR, a repeat comments, green comments only with a PR open', () => {
  assert.equal(planTriage({ conclusion: 'failure', openPr: null }), 'open');
  assert.equal(planTriage({ conclusion: 'failure', openPr: { number: 3 } }), 'comment-failure');
  assert.equal(planTriage({ conclusion: 'success', openPr: { number: 3 } }), 'comment-green');
  assert.equal(planTriage({ conclusion: 'success', openPr: null }), 'none');
  assert.equal(planTriage({ conclusion: 'cancelled', openPr: null }), 'none');
});

test('the log tail ends at the last error, without timestamps or colours', () => {
  const log = ['2026-10-11T23:47:01.1234567Z step one', '2026-10-11T23:47:02.0Z \x1b[31mnot ok 3 - hands\x1b[0m', '2026-10-11T23:47:03.0Z ##[error]Process completed with exit code 1.', '2026-10-11T23:47:04.0Z Post job cleanup.'].join('\n');
  assert.equal(logTail(log), 'step one\nnot ok 3 - hands\n##[error]Process completed with exit code 1.');
  assert.equal(logTail(log, 1), '##[error]Process completed with exit code 1.');
});

test('the log tail drops a leading byte order mark and every terminal escape, not only colours', () => {
  const log = ['﻿2026-10-11T23:47:01.0Z \x1b[36;1mnode test\x1b[0m\x1b[K', '2026-10-11T23:47:02.0Z ##[error]boom'].join('\n');
  assert.equal(logTail(log), 'node test\n##[error]boom');
});

test('the summary names the run, the failed jobs and steps, with their log tails', () => {
  const s = failureSummary({ runUrl: 'https://example.invalid/run/1', sha: 'abcdef1234', jobs: [{ name: 'Node tests', steps: ['Run pnpm test'], tail: 'not ok 3' }] });
  assert.match(s, /failed at abcdef1: https:\/\/example.invalid\/run\/1/);
  assert.match(s, /### Node tests\n\nFailed step: Run pnpm test\n\n```text\nnot ok 3\n```/);
});

test('the scaffold is a valid change with one open task, and the PR body links it', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-'));
  fs.mkdirSync(path.join(repo, 'openspec', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'openspec', 'config.yaml'), 'schema: spec-driven\n');
  const files = scaffold({ change: 'fix-nightly-2026-10-11', date: '2026-10-11', summary: 'Nightly CI failed.' });
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), text);
  }
  execFileSync(process.execPath, [OPENSPEC_BIN, 'validate', '--all', '--strict', '--no-interactive'], { cwd: repo, stdio: 'pipe', env: { ...process.env, CI: '1' } });
  assert.match(files['openspec/changes/fix-nightly-2026-10-11/tasks.md'], /- \[ \] 1\.1/);
  assert.deepEqual(parseLink(prBody({ change: 'fix-nightly-2026-10-11', summary: 'x' })).link, { version: 1, change: 'fix-nightly-2026-10-11' });
});

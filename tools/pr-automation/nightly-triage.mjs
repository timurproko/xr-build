#!/usr/bin/env node
// Nightly triage: after the scheduled CI run on main, a failure opens one draft PR `fix/nightly-<date>` (label
// `nightly-failure`) holding an OpenSpec change scaffold with the failure summary, linked to it; while that PR is
// open, later failures and the next green run become comments on it. Never merges, marks ready or arms auto-merge.
//
//   node tools/pr-automation/nightly-triage.mjs --repo <checkout> --run <run-id> --author "<name> <email>"
//        (GH_TOKEN as the repo's GitHub App, GITHUB_REPOSITORY)

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const NIGHTLY_LABEL = 'nightly-failure';
const TAIL_LINES = 40;

/** What to do: 'open' (new draft PR), 'comment-failure', 'comment-green' or 'none'. */
export function planTriage({ conclusion, openPr }) {
  if (conclusion === 'success') return openPr ? 'comment-green' : 'none';
  if (conclusion !== 'failure') return 'none';
  return openPr ? 'comment-failure' : 'open';
}

/** The last lines of a job log up to its last error, without timestamps or colour codes. */
export function logTail(log, lines = TAIL_LINES) {
  const clean = log.split(/\r?\n/).map((l) => l.replace(/^﻿?\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''));
  let end = clean.length;
  for (let i = clean.length - 1; i >= 0; i--) if (clean[i].includes('##[error]')) { end = i + 1; break; }
  return clean.slice(0, end).filter((l) => l.trim()).slice(-lines).join('\n');
}

/** Markdown summary of a failed run: [{ name, steps: [names], tail }]. */
export function failureSummary({ runUrl, sha, jobs }) {
  const parts = [`Nightly CI on \`main\` failed at ${sha.slice(0, 7)}: ${runUrl}`, ''];
  for (const job of jobs) {
    parts.push(`### ${job.name}`, '', `Failed step${job.steps.length === 1 ? '' : 's'}: ${job.steps.join(', ') || 'unknown'}`, '', '```text', job.tail, '```', '');
  }
  return parts.join('\n').trimEnd();
}

/** The OpenSpec change scaffold for a fix: { relativePath: text }. Its open task keeps it from being finalized. */
export function scaffold({ change, date, summary }) {
  const dir = `openspec/changes/${change}`;
  return {
    [`${dir}/.openspec.yaml`]: `schema: spec-driven\ncreated: ${date}\n# A fix that changes behaviour adds spec deltas and drops this line.\nskip_specs: true\n`,
    [`${dir}/proposal.md`]: `## Why\n\nThe nightly CI run on main failed; this change finds the cause and fixes it.\n\n${summary}\n\n## What Changes\n\n- To be written once the cause is known.\n`,
    [`${dir}/design.md`]: `# Design\n\nTo be written once the cause is known.\n`,
    [`${dir}/tasks.md`]: `# Tasks\n\n- [ ] 1.1 Find the cause of the nightly failure and plan the fix here; verify the failing job passes on this branch\n`,
  };
}

export function prBody({ change, summary }) {
  return [
    '## Proposal', '', 'The nightly CI run on `main` failed. This draft is where the fix is planned and made.', '',
    '## Implementation', '', '- To be planned: see the failure below and the change scaffold.', '',
    '## Failure', '', summary, '',
    '## Automation', '', '<details>', '<summary>Used by CI to link this PR to its OpenSpec change</summary>', '',
    '```openspec-implementation', JSON.stringify({ version: 1, change }), '```', '', '</details>',
  ].join('\n');
}

// A job's log, read with fetch: `gh api` refuses to print a response with terminal escape sequences, and CI logs have them.
async function jobLog(repoName, id) {
  const res = await fetch(`https://api.github.com/repos/${repoName}/actions/jobs/${id}/logs`, {
    headers: { authorization: `Bearer ${process.env.GH_TOKEN}`, accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`job ${id} log: HTTP ${res.status}`);
  return res.text();
}

async function main(a) {
  const repoName = process.env.GITHUB_REPOSITORY;
  for (const k of ['repo', 'run', 'author']) if (!a[k]) throw new Error(`missing --${k}`);
  const gh = (args, input) => execFileSync('gh', args, { encoding: 'utf8', input, maxBuffer: 64 << 20, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
  const api = (p, method = 'GET', body) => JSON.parse(gh(['api', '-X', method, p, ...(body ? ['--input', '-'] : [])], body && JSON.stringify(body)) || 'null');
  const git = (...g) => execFileSync('git', ['-C', a.repo, ...g], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

  const run = api(`repos/${repoName}/actions/runs/${a.run}`);
  const open = api(`repos/${repoName}/issues?state=open&labels=${NIGHTLY_LABEL}&per_page=10`).filter((i) => i.pull_request);
  const openPr = open[0] ?? null;
  const plan = planTriage({ conclusion: run.conclusion, openPr });
  console.log(`run ${run.id} (${run.event}, ${run.conclusion}) at ${run.head_sha.slice(0, 7)}: ${plan}`);
  if (plan === 'none') return;
  if (plan === 'comment-green') {
    api(`repos/${repoName}/issues/${openPr.number}/comments`, 'POST', { body: `Nightly CI on \`main\` is green again at ${run.head_sha.slice(0, 7)}: ${run.html_url}` });
    return;
  }

  const jobs = api(`repos/${repoName}/actions/runs/${run.id}/jobs?per_page=100`).jobs.filter((j) => j.conclusion === 'failure');
  const summary = failureSummary({
    runUrl: run.html_url,
    sha: run.head_sha,
    jobs: await Promise.all(jobs.map(async (j) => ({
      name: j.name,
      steps: j.steps.filter((s) => s.conclusion === 'failure').map((s) => s.name),
      tail: logTail(await jobLog(repoName, j.id)),
    }))),
  });
  if (plan === 'comment-failure') {
    api(`repos/${repoName}/issues/${openPr.number}/comments`, 'POST', { body: `Failed again.\n\n${summary}` });
    return;
  }

  const date = (run.created_at ?? new Date().toISOString()).slice(0, 10);
  const change = `fix-nightly-${date}`;
  const branch = `fix/nightly-${date}`;
  git('checkout', '--quiet', '-B', branch, run.head_sha);
  for (const [file, text] of Object.entries(scaffold({ change, date, summary }))) {
    fs.mkdirSync(path.dirname(path.join(a.repo, file)), { recursive: true });
    fs.writeFileSync(path.join(a.repo, file), text);
  }
  const m = /^(.+?)\s*<([^>]+)>$/.exec(a.author);
  if (!m) throw new Error('author must be "Name <email>"');
  git('add', '-A', '--', `openspec/changes/${change}`);
  git('-c', `user.name=${m[1]}`, '-c', `user.email=${m[2]}`, 'commit', '--quiet', '--no-verify', '-m', `docs(openspec): scaffold ${change}`);
  git('push', '--quiet', '--force-with-lease', 'origin', `HEAD:refs/heads/${branch}`);
  const pr = api(`repos/${repoName}/pulls`, 'POST', { title: `fix(ci): nightly failure ${date}`, head: branch, base: 'main', draft: true, body: prBody({ change, summary }) });
  api(`repos/${repoName}/issues/${pr.number}/labels`, 'POST', { labels: [NIGHTLY_LABEL] });
  console.log(`opened draft #${pr.number}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  const a = {};
  for (let i = 0; i < argv.length; i += 2) a[argv[i].replace(/^--/, '')] = argv[i + 1];
  try {
    await main(a);
  } catch (e) {
    console.error(String(e.stderr || e.message || e));
    process.exit(1);
  }
}

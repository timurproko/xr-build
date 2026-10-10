#!/usr/bin/env node
// Docs-only auto-merge: a ready PR to main that changes only documentation gets GitHub's auto-merge (squash),
// so it merges by itself once "CI required" passes. A PR that stops being docs-only, turns draft or gets the
// `no-auto-merge` label loses the auto-merge this tool armed; auto-merge a person armed is left alone.
//
//   node tools/pr-automation/docs-auto-merge.mjs <pr-number>     (GH_TOKEN, GITHUB_REPOSITORY)
//
// Runs from main's copy (the workflow's pull_request_target checkout), never from the PR's.

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const OPT_OUT_LABEL = 'no-auto-merge';
const BOT_LOGINS = new Set(['github-actions[bot]', 'github-actions']);

/** Documentation: docs/, openspec/, and Markdown anywhere except agent and CI configuration. */
export function isDocsPath(file) {
  if (file.startsWith('.claude/') || file.startsWith('.github/')) return false;
  return file.startsWith('docs/') || file.startsWith('openspec/') || file.toLowerCase().endsWith('.md');
}

/**
 * What to do with a PR: 'arm' (enable auto-merge), 'disarm' (remove the auto-merge this tool armed) or 'none'.
 * `files` are the changed paths, both names of a rename included.
 */
export function planAutoMerge({ files, draft, labels, sameRepo, baseRef, autoMergeBy }) {
  const eligible = sameRepo && baseRef === 'main' && !draft && !labels.includes(OPT_OUT_LABEL)
    && files.length > 0 && files.every(isDocsPath);
  if (eligible) return autoMergeBy ? 'none' : 'arm';
  return autoMergeBy && BOT_LOGINS.has(autoMergeBy) ? 'disarm' : 'none';
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function main(prNumber) {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo || !/^\d+$/.test(prNumber ?? '')) throw new Error('usage: docs-auto-merge.mjs <pr-number> (GITHUB_REPOSITORY set)');
  const pr = JSON.parse(gh(['api', `repos/${repo}/pulls/${prNumber}`]));
  if (pr.state !== 'open') return console.log(`#${prNumber} is ${pr.state}: nothing to do`);
  const pages = JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repo}/pulls/${prNumber}/files`]));
  const files = pages.flat().flatMap((f) => (f.previous_filename ? [f.filename, f.previous_filename] : [f.filename]));
  const plan = planAutoMerge({
    files,
    draft: pr.draft,
    labels: pr.labels.map((l) => l.name),
    sameRepo: pr.head.repo?.full_name === repo,
    baseRef: pr.base.ref,
    autoMergeBy: pr.auto_merge?.enabled_by?.login ?? null,
  });
  console.log(`#${prNumber}: ${files.length} file(s), plan: ${plan}`);
  if (plan === 'disarm') gh(['pr', 'merge', prNumber, '--repo', repo, '--disable-auto']);
  if (plan !== 'arm') return;
  try {
    gh(['pr', 'merge', prNumber, '--repo', repo, '--auto', '--squash', '--match-head-commit', pr.head.sha]);
  } catch (e) {
    // Checks already passed ("clean status"): GitHub will not arm auto-merge, so merge now.
    if (!/clean status/i.test(String(e.stderr))) throw e;
    gh(['pr', 'merge', prNumber, '--repo', repo, '--squash', '--match-head-commit', pr.head.sha]);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv[2]);
  } catch (e) {
    console.error(String(e.stderr || e.message || e));
    process.exit(1);
  }
}

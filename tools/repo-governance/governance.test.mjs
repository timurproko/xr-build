import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { CONFIG_PATH, CONFIRM, check, diffDeclared, run } from './governance.mjs';

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const REPO = 'owner/repo';

/** A fake GitHub holding `state`; records writes. Rulesets come back with ids, links and extra defaults. */
function fakeGitHub(state) {
  const writes = [];
  const api = (method, p, body) => {
    if (method !== 'GET') {
      writes.push({ method, p, body });
      if (p === `repos/${REPO}`) Object.assign(state.repository, body);
      else if (p.endsWith('/actions/permissions/workflow')) Object.assign(state.actions, body);
      else if (p.endsWith('/rulesets')) state.rulesets.push({ id: 99, ...structuredClone(body) });
      else if (p.includes('/rulesets/')) Object.assign(state.rulesets.find((r) => p.endsWith(`/${r.id}`)), structuredClone(body));
      else if (p.endsWith('/labels')) state.labels.push({ ...body });
      else if (p.includes('/labels/')) Object.assign(state.labels.find((l) => p.endsWith(`/${encodeURIComponent(l.name)}`)), body);
      return {};
    }
    if (p === `repos/${REPO}`) return { ...state.repository, has_wiki: true, full_name: REPO };
    if (p.endsWith('/actions/permissions/workflow')) return state.actions;
    if (p.endsWith('/rulesets')) return state.rulesets.map((r) => ({ id: r.id, name: r.name }));
    if (p.includes('/rulesets/')) return state.rulesets.find((r) => p.endsWith(`/${r.id}`));
    if (p.includes('/labels')) return state.labels;
    throw new Error(`unexpected ${p}`);
  };
  return { api, writes };
}

/** A live repository matching the config, with the extra keys GitHub adds. */
function matching() {
  const rs = structuredClone(config.rulesets[0]);
  rs.rules.find((r) => r.type === 'pull_request').parameters.required_reviewers = [];
  rs.rules.find((r) => r.type === 'required_status_checks').parameters.do_not_enforce_on_create = false;
  return {
    repository: structuredClone(config.repository),
    actions: structuredClone(config.actions),
    rulesets: [{ id: 7, _links: { self: {} }, created_at: 'x', updated_at: 'y', source: REPO, ...rs }, { id: 8, name: 'someone-elses', rules: [] }],
    labels: [...config.labels.map((l) => ({ ...l, color: l.color.toUpperCase(), id: 1 })), { name: 'bug', color: 'd73a4a', description: 'x' }],
  };
}

test('only declared keys are compared: GitHub\'s extra keys, ids and undeclared rulesets or labels are not drift', () => {
  const lines = [];
  assert.equal(run(['check'], { api: fakeGitHub(matching()).api, repo: REPO, config, out: (l) => lines.push(l) }), 0);
  assert.match(lines[0], /matches/);
});

test('a changed setting, rule parameter, missing label or extra rule is reported with its path and both values', () => {
  const live = matching();
  live.repository.allow_rebase_merge = true;
  live.rulesets[0].rules.find((r) => r.type === 'pull_request').parameters.allowed_merge_methods = ['merge', 'squash'];
  live.rulesets[0].rules.push({ type: 'creation' });
  live.labels = live.labels.filter((l) => l.name !== 'nightly-failure');
  const paths = check(config, live).map((d) => d.path);
  assert.deepEqual(paths, [
    'repository.allow_rebase_merge',
    'rulesets[protect-main].rules[pull_request].parameters.allowed_merge_methods',
    'rulesets[protect-main].rules[creation]',
    'labels[nightly-failure]',
  ]);
  const lines = [];
  assert.equal(run(['check'], { api: fakeGitHub(live).api, repo: REPO, config, out: (l) => lines.push(l) }), 1);
  assert.match(lines[0], /repository\.allow_rebase_merge: declared false, live true/);
});

test('arrays of plain values compare as sets; order does not matter', () => {
  assert.deepEqual(diffDeclared({ a: ['x', 'y'] }, { a: ['y', 'x'] }), []);
  assert.equal(diffDeclared({ a: ['x'] }, { a: ['x', 'y'] }).length, 1);
});

test('apply without the confirm flag prints the plan and writes nothing', () => {
  const live = matching();
  live.repository.allow_merge_commit = true;
  const gh = fakeGitHub(live);
  const lines = [];
  assert.equal(run(['apply'], { api: gh.api, repo: REPO, config, out: (l) => lines.push(l) }), 0);
  assert.deepEqual(gh.writes, []);
  assert.match(lines.join('\n'), /PATCH repos\/owner\/repo {2}\(repository settings\)[\s\S]*dry run: nothing written/);
});

test('apply with the flag writes the declared state, creates missing items, deletes nothing, then checks clean', () => {
  const live = matching();
  live.repository.allow_merge_commit = true;
  live.rulesets = live.rulesets.filter((r) => r.name !== 'protect-main');
  live.labels = live.labels.filter((l) => l.name !== 'openspec-in-progress');
  live.labels.find((l) => l.name === 'no-auto-merge').description = 'old';
  const gh = fakeGitHub(live);
  const lines = [];
  assert.equal(run(['apply', '--confirm', CONFIRM], { api: gh.api, repo: REPO, config, out: (l) => lines.push(l) }), 0);
  assert.deepEqual(gh.writes.map((w) => `${w.method} ${w.p}`), [
    'PATCH repos/owner/repo',
    'POST repos/owner/repo/rulesets',
    'PATCH repos/owner/repo/labels/no-auto-merge',
    'POST repos/owner/repo/labels',
  ]);
  assert.ok(!gh.writes.some((w) => w.method === 'DELETE'));
  assert.ok(live.rulesets.some((r) => r.name === 'someone-elses') && live.labels.some((l) => l.name === 'bug'), 'undeclared items stay');
  assert.match(lines.at(-1), /matches/);
});

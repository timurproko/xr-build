# Tasks

## 1. Bot identity (maintainer)

- [ ] 1.1 Maintainer creates the GitHub App (design D11: repository permissions Contents, Pull requests, Issues read and write; Administration and Metadata read; no webhook), installs it on this repository only, and sets the Actions variable `XRB_BOT_APP_ID` and the secret `XRB_BOT_PRIVATE_KEY`; verify with a `workflow_dispatch` probe step that mints a token with `actions/create-github-app-token` and reads the repository with it
- [ ] 1.2 Add a shared guard step that stops a workflow needing the App with a message naming the missing variable or secret; verify by running the probe on a fork-less branch with the variable unset (dispatch input) and reading the message

## 2. PR body contract

- [ ] 2.1 Add `tools/pr-automation/pr-body.mjs`: parse the `openspec-implementation` fence (version 1, change id as a folder name, optional `archive` and `finalizedHead`), report malformed blocks, and rewrite only the fence; verify with `node --test` cases for a valid block, no block, bad JSON, unknown version, bad id and a rewrite that leaves the rest of the body byte-identical
- [ ] 2.2 Replace `.github/pull_request_template.md` with Proposal / Implementation / Acceptance / collapsed Automation (empty fence); verify the parser reads the template's block as "not linked" until a change id is filled in

## 3. Delivery skill and conventions

- [ ] 3.1 Write `.claude/skills/change-delivery/SKILL.md` (design D1, D3, D12): preflight sweep, worktree, plan-first draft, approval gate, implementation in the same PR, acceptance, ready, finalization, handoff report, cleanup, never merge; verify the agent tool lists the skill and a dry read-through against this change's own PR finds no step it skips
- [ ] 3.2 Point `.claude/CLAUDE.md` and `openspec/config.yaml` at the skill and replace the "Changes and pull requests" rules it now owns with a short summary; verify `pnpm check:names` passes and no rule is stated in two places with different wording
- [ ] 3.3 Add `.artifacts/` to `.gitignore`; verify `git status` stays clean after writing `.artifacts/pr-body.md` in a worktree

## 4. Worktree sweep and handoff

- [ ] 4.1 Add `pnpm worktree handoff <name> [--change <id>] [--pr <n>]`: write `.artifacts/handoff.json` and print the report skeleton; verify with a test on a temporary repo and worktree
- [ ] 4.2 Add `pnpm worktree sweep [--apply]` with the states of design D12 (PR state from `gh`, injectable for tests) and removal of merged clean worktrees only; verify with tests for each state, including that `--apply` keeps `dirty`, `active`, `closed` and `unknown`
- [ ] 4.3 Add `remove --discard` for a worktree whose PR closed unmerged; verify a test refuses it for an open or merged PR and removes it for a closed one

## 5. CI readiness, base-commit policy and delivery check

- [ ] 5.1 Add `tools/pr-automation/delivery.mjs` (design D5): linked change still active, malformed block, untracked changes to an active change folder, `openspec-in-progress` label; verify with `node --test` cases over fixture trees and bodies for each pass and fail path
- [ ] 5.2 In `ci.yml`, add `ready_for_review`, `converted_to_draft` and `edited` types, a `Readiness` job, skip Node and host jobs on drafts, and a `Delivery` job reading `delivery.mjs` from the base commit; `CI required` accepts `Delivery` success or skipped; verify on throwaway PRs: a draft runs only the light jobs, marking it ready runs the rest, and a PR that edits `delivery.mjs` still runs `main`'s copy

## 6. OpenSpec finalization

- [ ] 6.1 Add `tools/pr-automation/finalize.mjs` (design D4): already-finalized no-op, open-task refusal with the list, archive with the pinned CLI, strict validation, fence update; verify with `node --test` on a temporary repo holding a fixture change (archive result, specs synced, idempotent second run, open-task refusal)
- [ ] 6.2 Add `.github/workflows/openspec-finalization.yml` (`pull_request_target`, non-draft same-repo linked PRs, scripts from `main`, PR head checked out with the App token, commit and push as the App, body update); verify on a throwaway linked PR: marking it ready produces one finalization commit, CI reruns on it, `Delivery` turns green, and a later unrelated push makes no new finalization commit
- [ ] 6.3 Verify the refusal end to end: a throwaway linked PR with an unchecked task marked ready gets no commit and a run summary naming the task

## 7. Docs auto-merge on the App

- [ ] 7.1 Extend `planAutoMerge` to exclude PRs that link a change or touch an active change folder; verify with new `node --test` cases next to the existing ones
- [ ] 7.2 Switch `docs-auto-merge.yml` to an App token; verify a throwaway README-only PR merges by itself and a `CI` run starts on `main` for the merge commit

## 8. Unarchived change report

- [ ] 8.1 Add `tools/pr-automation/reconcile.mjs` (design D8, merged-PR lookup injectable) and `.github/workflows/openspec-reconcile.yml` (nightly and dispatch, issue labelled `openspec-reconcile` updated in place, closed when clean); verify with `node --test` for the listing and a dispatch run that opens, then closes, the issue against a fixture branch

## 9. Repository settings as code

- [ ] 9.1 Add `config/github-repository-governance.json` with today's live settings, the `protect-main` ruleset and labels `no-auto-merge`, `openspec-in-progress`, `openspec-reconcile`, `nightly-failure`; verify `check` passes against the live repository right after
- [ ] 9.2 Add `tools/repo-governance/governance.mjs` `check` and `apply --confirm apply-xr-build-governance` (design D9; API calls injectable); verify with `node --test` for declared-keys-only comparison, ruleset normalisation, the dry run without the flag and no deletion of undeclared rulesets or labels
- [ ] 9.3 Add `.github/workflows/governance-drift.yml` (weekly, on changes to the file, dispatch; App token; issue on drift); verify by toggling a declared setting in the web UI, dispatching the check, reading the issue, and restoring with `apply`

## 10. Nightly run and triage

- [ ] 10.1 Add a nightly `schedule` to `ci.yml`; verify a dispatched run with the schedule path selects every job
- [ ] 10.2 Add `tools/pr-automation/nightly-triage.mjs` (design D10: scaffold, draft PR, label, link, comment on repeat and on green; GitHub calls injectable) and `.github/workflows/nightly-triage.yml` (`workflow_run` of `CI`, schedule event only, App token); verify with `node --test` for first failure, repeat failure and green-again, and once end to end by dispatching the triage against a deliberately failing run on a throwaway branch

## 11. Docs and close-out

- [ ] 11.1 Update `README.md` (contributing: worktrees, PR flow, the App) and `.claude/CLAUDE.md` layout lines for the new tools, workflows and `config/`; verify `pnpm check:names`, `pnpm test` and `openspec validate --all --strict` pass
- [ ] 11.2 Archive this change in its own PR by hand (design D13: `openspec archive pr-delivery-automation --yes`); verify the specs `change-delivery`, `ci-validation` and `repository-governance` exist under `openspec/specs/` and strict validation passes

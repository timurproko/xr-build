---
name: change-delivery
description: Deliver a change to the XR Build core through its PR flow - own worktree and branch, plan first as a draft PR, implementation only after the maintainer approves, OpenSpec finalization in the PR, handoff and cleanup. Use whenever asked to make, fix, plan or ship a change in this repo (code, docs, specs or CI), and before opening, updating or finishing a PR.
---

# Change delivery

The process for every change to the core. Rules it relies on: `.claude/CLAUDE.md` (names, Git, layout) and
`openspec/config.yaml` (planning). Never merge, arm auto-merge or push to `main`; the maintainer merges.

## 1. Preflight

- From the primary checkout (it stays on `main`): `pnpm worktree sweep` and relay its lines. `--apply` only removes
  merged, clean worktrees; never remove a `dirty`, `active`, `closed` or `unknown` one by hand.
- Reuse a worktree only when its branch, change and PR are exactly this task's. Otherwise
  `pnpm worktree add <type>/<short-desc>` (types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `ci`, `perf`).
- Work only in `.worktrees/<short-desc>/`, by absolute path. Never edit the primary checkout or another task's worktree.
- Scratch (PR bodies, logs, patches, captured output) goes in the worktree's `.artifacts/` (git-ignored), never the
  system temp folder, the home folder or another checkout.

## 2. Plan (draft PR)

- A change that needs a plan (new behaviour, a spec change, anything beyond a small fix) starts as an OpenSpec change
  in `openspec/changes/<change-id>/`: proposal, design, spec deltas, tasks (each ending in a verify clause). A fix that
  changes no spec sets `skip_specs: true` in its `.openspec.yaml`.
- Commit `docs(openspec): propose <change-id>`, push, and open a **draft** PR to `main`: title `type(scope): subject`,
  body from `.github/pull_request_template.md` written to `.artifacts/pr-body.md` and passed with `--body-file`:
  - `## Proposal`: one or two sentences.
  - `## Implementation`: two to five bullets.
  - `## Automation`: the collapsed block with `{"version":1,"change":"<change-id>"}` in the `openspec-implementation` fence.
  - No `## Acceptance` yet, no list of commands, no checkboxes.
- Hand off (section 6) and **stop**. No implementation until the maintainer approves the plan and asks for the
  implementation in words. A request that asks for a plan and its implementation together is approval only when it
  says the plan needs no review.

## 3. Implement (same worktree, branch and PR)

- Update proposal, design, deltas and tasks before the code they cover when the plan shifts.
- Commits: `type(scope): subject`, concise; no AI attribution lines anywhere.
- Tick each task in `tasks.md` only when its verify clause holds. A task that can only be verified after merge belongs
  in a follow-up change, not ticked here.
- Run the focused tests for what changed (`node --test` in the package, `host-tests` for the host) and `pnpm check:names`.
- Add `## Acceptance` before `## Automation`: one to ten plain bullets saying what now holds, specific to this change.

## 4. Ready and finalization

- Bring the branch up to date with `origin/main` if it is behind, then mark the PR ready.
- The OpenSpec finalization workflow (the repo bot) archives the linked change in the PR branch, syncs the specs,
  commits `docs(openspec): finalize <change-id>` and records the archive in the Automation block. It refuses while
  `tasks.md` has open tasks; its run lists them.
- Always `git pull` before pushing again; never revert a finalization commit, push fixes on top.
- CI's `Delivery` job stays red ("awaiting finalization") until that commit lands; `CI required` is the gate.
- A PR that edits an active change folder without linking it fails `Delivery`; a change delivered over several PRs
  uses the `openspec-in-progress` label on the intermediate PRs.

## 5. CI

- Drafts run only the name guard, OpenSpec and change detection; ready PRs run every job their paths need.
- Do not watch CI in the foreground; check the result afterwards (`gh pr checks <n>`) and report it.
- Fix failures in the same PR without weakening a test.
- Docs-only PRs that link no change merge by themselves once CI passes (`no-auto-merge` opts out).

## 6. Handoff

After pushing a plan, after CI is green, and after any repair push:
`pnpm worktree handoff <short-desc> --change <change-id> --pr <n>` and fill its skeleton in the reply:
worktree, branch and PR, commit, commands run, behaviour, gaps (each with what happens to it), and one manual test
command for the maintainer.

## 7. After the merge

- Verify: the PR merged, the archive and synced specs are on `main`, the remote branch is gone. Only then report the
  change as delivered; never edit a merged PR's body.
- Local cleanup is the next session's `pnpm worktree sweep --apply` (or `pnpm worktree remove <short-desc>`).
- A PR closed unmerged: `pnpm worktree remove <short-desc> --discard`, only when the maintainer says its work is not
  needed.

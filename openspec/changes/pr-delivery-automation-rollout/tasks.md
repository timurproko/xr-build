# Tasks

## 1. Settings and bot

- [ ] 1.1 Maintainer runs `pnpm governance apply --confirm apply-xr-build-governance`; verify it creates `openspec-in-progress`, `openspec-reconcile`, `nightly-failure` and `governance-drift` and its closing `check` reports a match
- [ ] 1.2 Dispatch `Bot probe`; verify the run names the App's bot login and reads the repository, the workflow permissions and the `protect-main` ruleset with the App token
- [ ] 1.3 Dispatch `Bot probe` with `simulate_missing`; verify the run stops at the guard with a message naming `XRB_BOT_APP_ID`

## 2. PR flow

- [ ] 2.1 Open a ready PR that only fixes a README sentence; verify the App arms squash auto-merge, the PR merges once `CI required` passes, and a `CI` run starts on `main` for the merge commit
- [ ] 2.2 Deliver this change through its own PR linked to `pr-delivery-automation-rollout`; verify marking it ready with all tasks done produces one `docs(openspec): finalize pr-delivery-automation-rollout` commit by the App, CI reruns on it, `Delivery` turns green and the Automation block records `archive` and `finalizedHead`; a later push makes no second finalization commit
- [ ] 2.3 Before 2.2, mark the same PR ready with this task still open; verify no commit is made and the finalization run fails with a summary naming the open task
- [ ] 2.4 Verify on this change's PR that the `Delivery` job runs `main`'s `delivery.mjs` (log shows the base commit's policy path), and that as a draft it runs only `Readiness`, `Changes`, `Name guard`, `OpenSpec` and `CI required`

## 3. Scheduled workflows

- [ ] 3.1 Dispatch `OpenSpec reconcile`; verify it lists the active changes, reports no merged-but-unarchived change and opens no issue
- [ ] 3.2 Turn on rebase merging in the repository settings, dispatch `Governance drift`; verify an issue labelled `governance-drift` names `repository.allow_rebase_merge`; restore with `pnpm governance apply --confirm apply-xr-build-governance`, dispatch again, and verify the issue is closed
- [ ] 3.3 Dispatch `CI` on `main`; verify every job runs regardless of paths, including the host build
- [ ] 3.4 Push a throwaway branch with a failing test, dispatch `CI` on it, then dispatch `Nightly triage` with that run's id; verify a draft PR `fix/nightly-<date>` labelled `nightly-failure` opens with the failure summary and a linked, valid change scaffold; close it unmerged and delete its branch and the throwaway branch

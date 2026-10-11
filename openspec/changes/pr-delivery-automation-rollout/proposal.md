## Why

`pr-delivery-automation` adds workflows that GitHub runs only from `main`'s copy (`pull_request_target`, `workflow_run`,
`schedule`, `workflow_dispatch`), so they could not run end to end before it merged. This change checks each of them
live on the repository, fixes what the checks find, and is the first change the repo bot finalizes.

## What Changes

- Apply the governance file once (creates the workflow labels) and confirm `check` is clean.
- Run the bot probe, with and without the App id.
- Watch one docs-only PR merge by itself and start CI on `main`.
- Deliver this change through its own linked PR: a refused finalization while a task is open, then the bot's
  finalization commit, CI rerunning and `Delivery` turning green.
- Run the reconcile, governance drift and nightly triage workflows once each.
- Fix in this PR whatever the checks show is wrong.

## Impact

- Workflows and scripts from `pr-delivery-automation`, only where a check fails.
- No spec changes (`skip_specs`): the behaviour is specified by `pr-delivery-automation`.

# repository-governance Specification

## Purpose
Keeps the GitHub repository's settings, the `main` ruleset and the labels the automation relies on in a reviewed file,
with drift reported and changes applied only by the maintainer.

## Requirements

### Requirement: Declared repository state
`config/github-repository-governance.json` SHALL declare the repository's merge settings, the Actions default workflow
permissions, the `protect-main` ruleset and the labels the workflows use. The `protect-main` ruleset SHALL have no
bypass actors, so nobody, an admin included, merges to `main` before `CI required` passes. Changes to the file SHALL
go through a PR like any other file.

#### Scenario: Reviewing a settings change
- **WHEN** the maintainer wants merge commits allowed again
- **THEN** the change is a PR editing the file, and the live setting changes only after an apply

#### Scenario: Merging before the checks
- **WHEN** the maintainer marks a PR ready and tries to merge it while `Delivery` is still failing
- **THEN** GitHub offers no bypass and the PR merges only after `CI required` passes

### Requirement: Drift check
`tools/repo-governance/governance.mjs check` SHALL compare only the declared keys with the live repository and exit
with an error and a readable difference when they disagree. The maintainer SHALL run it locally with their own
credentials; no workflow SHALL read the repository's settings, so the repo bot needs no administration access.

#### Scenario: Setting changed in the web UI
- **WHEN** someone turns on rebase merging in the repository settings
- **THEN** the next `check` exits with an error naming `repository.allow_rebase_merge` with the declared and live values

#### Scenario: Bot permissions
- **WHEN** the bot workflows run
- **THEN** none of them reads the repository's settings or rulesets, and the App works without administration access

### Requirement: Confirmed apply
`governance.mjs apply` SHALL write the declared state only with `--confirm apply-xr-build-governance`, with the caller's
own credentials, SHALL NOT delete rulesets or labels the file does not declare, and SHALL run the drift check after
writing.

#### Scenario: Apply without confirmation
- **WHEN** `apply` runs without the confirm flag
- **THEN** it prints what it would change and writes nothing

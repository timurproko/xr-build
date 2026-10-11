## MODIFIED Requirements

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

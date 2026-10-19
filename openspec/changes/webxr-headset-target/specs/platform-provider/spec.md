# Spec Delta

## MODIFIED Requirements

### Requirement: Packager contract
A packager SHALL expose to the control panel and CLI: its platform name, the target it builds for (`host`, the
default, or `webxr`), the identity fields a project needs (with validation), a build step, and optionally a local
install step. A `host` packager's build step SHALL turn a built app, the host runtime and the selected plugins into a
package, with build options that include `pluginDirs` (each selected plugin's folder by name, default
`<runtimeDir>/plugins`). A `webxr` packager's build step SHALL turn the built app, its icon and identity into a package
and SHALL receive no host runtime and no plugins. Packagers SHALL be found in the core's `packages/*` and the
workspace's `plugins/*`, `plugins/*/*`.

#### Scenario: Panel shows platform fields
- **WHEN** a project selects platform `station` and a packager for `station` is found
- **THEN** the panel shows and validates the fields that packager declares (for example package id, title, version)

#### Scenario: Plugins taken from the workspace
- **WHEN** the panel builds a package and passes each selected plugin's `bin/` folder in `pluginDirs`
- **THEN** the packager copies the selected plugins from that folder

#### Scenario: Older caller without pluginDirs
- **WHEN** a packager is called without `pluginDirs`
- **THEN** it takes the plugins from `<runtimeDir>/plugins`

#### Scenario: No packager installed
- **WHEN** no packager is present
- **THEN** the panel can still build and run every project, and shows packaging as unavailable

#### Scenario: Packager without a target
- **WHEN** a packager declares no target
- **THEN** it is treated as a `host` packager and works unchanged

#### Scenario: Headset package
- **WHEN** a project with target `webxr` and platform `headset` is packaged
- **THEN** the `headset` packager receives the built app, icon and identity, no host runtime and no plugins, and
  writes one package file to the workspace's `builds/`

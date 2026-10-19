# platform-provider Specification

## Purpose
Defines how a station platform launches and controls an XR Build app and how apps are packaged for it, so the core and
the control panel work with any platform, or none.

## Requirements

### Requirement: Standalone by default
With no platform provider selected the host SHALL run the app standalone: it SHALL NOT open any station connection,
and it SHALL exit only on its own quit paths (window close, `--exit-after=`, the page or the panel).

#### Scenario: Local run
- **WHEN** an app is run from the control panel with no platform
- **THEN** the host makes no network connection other than its loopback host channel

### Requirement: Station runtime lifecycle
A platform provider SHALL translate its station's commands into the core lifecycle `configure`, `play`, `stop` and
`exit`, and the host SHALL handle them the same way for every platform: `stop` and `exit` end the app through the clean
display exit.

#### Scenario: Station stops the app
- **WHEN** the station agent sends its stop command to a host running a station platform plugin
- **THEN** the host ends the app through the display's clean exit and the process exits

#### Scenario: Station connection lost
- **WHEN** a platform provider reports that its station is gone
- **THEN** the host behaves as for `exit`

### Requirement: Station parameters reach the page
A platform provider SHALL deliver the station's configuration as a string map, and the host SHALL make it available to
the page in a platform-neutral form.

#### Scenario: Parameters from the station
- **WHEN** the station agent sends `configure` with a map of station parameters
- **THEN** the page can read the same keys and values through the SDK, without platform-specific code

### Requirement: Packager contract
A packager SHALL expose to the control panel and CLI: its platform name, the identity fields a project needs (with
validation), a build step that turns a built app, the host runtime and the selected plugins into a package, and
optionally a local install step. Build options SHALL include `pluginDirs` (each selected plugin's folder by name, default
`<runtimeDir>/plugins`). Packagers SHALL be found in the core's `packages/*` and the workspace's `plugins/*`, `plugins/*/*`.

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

### Requirement: Packages carry the selected plugins
A package build SHALL include the core host runtime and exactly the plugins and plugin data the project selects, and
the packaged host SHALL start with those selections (from the `xrb-app.json` next to its exe) without extra
command-line options and without any workspace.

#### Scenario: Package with input, display and platform plugins
- **WHEN** a project with input `tracker`, display `stereo-panel` and platform `station` is packaged
- **THEN** the package contains the host, the three plugins and their runtime files, and starting it on a station runs
  the app in 3D with hands, controlled by the station agent

#### Scenario: Unselected plugins left out
- **WHEN** a project selects input `none`
- **THEN** the package contains no input plugin and no tracker runtime files

### Requirement: Packager target
A packager SHALL declare the target its packages run on: `host` (xrb-host with the selected plugins, the default when
it declares none) or `webxr` (a standalone headset). A project SHALL use only packagers of its own target.

#### Scenario: Packager without a target
- **WHEN** a packager declares no target
- **THEN** it is treated as a `host` packager and works unchanged

#### Scenario: Unknown target
- **WHEN** a packager declares a target other than `host` or `webxr`
- **THEN** it is not loaded and the panel reports the problem

### Requirement: Headset packages
A `webxr` packager's build step SHALL turn the built app, its icon and identity into a package for a standalone
headset, and SHALL receive no host runtime (`runtimeDir` empty), no plugins and no `pluginDirs`.

#### Scenario: Headset package
- **WHEN** a project with target `webxr` and platform `headset` is packaged
- **THEN** the `headset` packager receives the built app, icon and identity, no host runtime and no plugins, and
  writes one package file to the workspace's `builds/`

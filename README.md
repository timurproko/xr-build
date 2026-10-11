<h1 align="center">XR Build</h1>

<p align="center">
  three.js web apps on 3D displays with hand input.
</p>

<p align="center">
  <img alt="Windows x64" src="https://img.shields.io/badge/windows-x64-2638d2?style=flat-square">
  <img alt="Node 22+" src="https://img.shields.io/badge/node-%E2%89%A522-2638d2?style=flat-square">
  <img alt="pnpm 9" src="https://img.shields.io/badge/pnpm-9-2638d2?style=flat-square">
  <img alt="CEF 151" src="https://img.shields.io/badge/CEF-151-2638d2?style=flat-square">
</p>

<p align="center">
  <a href="#requirements">Requirements</a> ·
  <a href="#workspace">Workspace</a> ·
  <a href="#plugins">Plugins</a> ·
  <a href="#dependencies">Dependencies</a> ·
  <a href="#build">Build</a> ·
  <a href="#run">Run</a> ·
  <a href="#package">Package</a> ·
  <a href="#develop">Develop</a> ·
  <a href="#troubleshooting">Troubleshooting</a>
</p>

## Requirements

Toolchain (dev machine):

- Windows 11 x64
- Node.js 22 or newer and pnpm 9 (`corepack enable`)
- Visual Studio 2022 Build Tools with the C++ workload (CMake ships with it, see [Build](#build))
- `gh`, authenticated, only for `pnpm preview:readme`

The core runs without any device: the `desktop` display shows the page in a window and the `simulated`
or `replay` input stands in for hands. A 3D display, a hand tracker or a station platform comes from a
plugin, and each plugin lists the hardware and runtimes it needs.

<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/separator-dark.svg"><img src="docs/assets/readme/separator.svg" alt="" width="280"></picture></p>

## Workspace

This repo is the engine: the host, the plugin ABI, the SDK, the ui-kit and the control panel. Your
projects and plugins live apart from it, in a **workspace**: `%USERPROFILE%\.xr-build`, or the folder
in `XRB_HOME`. Keep the workspace in your own git repo; the core never writes to its history.

```text
<workspace>/
  projects/<section>/<name>/    projects: a folder with an xrb-project.json, in a section folder
  projects/Unsorted/<name>/     projects in no section (and new ones)
  projects/archive/<name>/      archived projects
  plugins/<name>/               plugins: a native CMake project and/or a packager package; built files in bin/
  xrb-panel.json                the panel's project list layout
  third_party/, builds/         plugin binaries, packages (not versioned, nor are plugins/*/bin/)
```

On first start the panel offers to create the workspace with a starter app; "New project" adds apps from
[`templates/app`](templates/app). Apps get the SDK straight from this repo's sources, with nothing to
install or publish: the panel sets `XRB_CORE` and the app's Vite config maps `@xr-build/sdk` and
`@xr-build/ui-kit` to it ([SDK](packages/sdk/README.md#getting-the-sdk-into-an-app)).

<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/separator-dark.svg"><img src="docs/assets/readme/separator.svg" alt="" width="280"></picture></p>

## Plugins

The core talks to providers for three roles, display, input and platform, and to packagers; it names no
device, tracker or platform. Built-in providers: display `desktop`; inputs `none`, `replay`, `simulated`.
Everything else is a plugin in the workspace's `plugins/`:

- **Native part:** a DLL built against the C ABI in
  [`native/plugin-sdk/include/xrb_plugin.h`](native/plugin-sdk/include/xrb_plugin.h). The panel configures
  each plugin's CMake project with `XRB_PLUGIN_SDK` (this repo's plugin SDK), `XRB_THIRD_PARTY` (the
  workspace's binaries), `XRB_CORE_THIRD_PARTY` (this repo's, e.g. nlohmann/json) and
  `XRB_PLUGIN_BIN_DIR` (the plugin's own `bin/`), where the plugin installs its files. The host gets each
  plugin's `bin/` with a `--plugin-dir=`.
- **Packager:** a package whose `package.json` names a module in `xrBuild.packager`, implementing the
  contract in [`packages/control-panel/src/packagers.ts`](packages/control-panel/src/packagers.ts).
- **Settings:** `--plugin.<name>.<key>=<value>`, or the project's `plugins.<name>` section.

A project picks its providers in its `xrb-project.json` (`display`, `input`, `platform`); a package
records them in `xrb-app.json` next to the exe.

<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/separator-dark.svg"><img src="docs/assets/readme/separator.svg" alt="" width="280"></picture></p>

## Dependencies

Native binaries live in `third_party/` folders, which are **not committed**. `pnpm fetch-deps` fills them
and checks every file against a pinned SHA-256. The core needs only two public downloads
([`tools/fetch-deps/sources.mjs`](tools/fetch-deps/sources.mjs), pinned in
[`tools/fetch-deps/deps.lock.json`](tools/fetch-deps/deps.lock.json)):

| Folder | What | Source |
|---|---|---|
| `cef/` | CEF 151 (Chromium 151) minimal, Windows x64 | cef-builds.spotifycdn.com |
| `nlohmann/` | nlohmann/json 3.12.0 | GitHub release |

```text
pnpm fetch-deps
```

A workspace plugin lists its own binaries in `plugins/<plugin>/deps.json`, pinned in the `deps.lock.json`
next to it; they go into the workspace's `third_party/`. A plugin's paths use variables (`${NAME}`); the
environment variable `XRB_<NAME>` overrides one, `XRB_GIT_ROOT` the common root (default `D:/Git`).

```text
pnpm fetch-deps --workspace
pnpm fetch-deps --workspace --plugins=<plugin>,<plugin>
```

Fetch only some sources (ids matched by prefix), or re-pin after a deliberate upgrade (and commit the lock):

```text
pnpm fetch-deps --only cef,nlohmann
pnpm fetch-deps --update-lock
```

JS dependencies (three.js, Vite, lucide, ...) come from the package registry through pnpm: `pnpm install`
here (`packages/*`, `tools/*`), and in the workspace (the panel runs it there when needed).

<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/separator-dark.svg"><img src="docs/assets/readme/separator.svg" alt="" width="280"></picture></p>

## Build

The control panel rebuilds `xrb-host.exe` and the workspace plugins itself when their sources are newer
than their builds ("Rebuild host"). By hand:

```text
cmake -S native/host -B native/host/build -G "Visual Studio 17 2022" -A x64
cmake --build native/host/build --config Release
```

No `cmake` on PATH? Use the one in VS Build Tools:
`Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe`.

A workspace plugin by hand (from the workspace, with `XRB_CORE` set to this repo), the same paths the panel
passes:

```text
cmake -S plugins/<p> -B plugins/<p>/build -G "Visual Studio 17 2022" -A x64 -DXRB_PLUGIN_SDK=%XRB_CORE%/native/plugin-sdk -DXRB_THIRD_PARTY=third_party -DXRB_CORE_THIRD_PARTY=%XRB_CORE%/third_party -DXRB_PLUGIN_BIN_DIR=plugins/<p>/bin
cmake --build plugins/<p>/build --config Release
```

<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/separator-dark.svg"><img src="docs/assets/readme/separator.svg" alt="" width="280"></picture></p>

## Run

Start the control panel (no console window; a second start only opens the running panel):

```text
start.vbs
```

Or from a terminal:

```text
pnpm panel
```

The panel runs on `http://127.0.0.1:5180` (`XRB_PANEL_PORT` to change it). It lists the workspace's
projects, builds them, runs them with their providers and live status, switches a 3D display between 2D
and 3D, shows the input provider's camera view and renders app icons.

Add "XR Build" to the Start menu:

```text
tools/add-to-start.vbs
```

Run the host directly in a window, with no device (options are `--name=value` only):

```text
native/host/build/Release/xrb-host.exe --app-dir=<built app folder> --display=desktop --input=simulated
```

List the built-in providers and the plugins the host finds (plus the workspace's):

```text
native/host/build/Release/xrb-host.exe --list-plugins --plugin-dir=%USERPROFILE%\.xr-build\plugins\<p>\bin
```

Common host options: `--url=`, `--app-dir=`, `--display=`, `--input=`, `--platform=`, `--plugin-dir=`,
`--plugin.<name>.<key>=<value>`, `--view=2d`, `--record-hands=`, `--camera-view=on`, `--exit-after=`, `--icon=`,
`--status=stdout`. Without a role option the host reads `--config=<file>` (the panel passes the project's
providers and plugin settings), else `<exe>\xrb-app.json` (a package has one), else it starts with the
desktop display and no input. Stop a running host with `taskkill /PID <pid>` (never `/F`: it skips the
providers' cleanup, and a 3D display may stay in 3D).

Logs: `%LOCALAPPDATA%\XRBuild\logs`.

<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/separator-dark.svg"><img src="docs/assets/readme/separator.svg" alt="" width="280"></picture></p>

## Package

Build a package from the panel (Build package). The panel uses the packager of the project's platform
plugin; with none it says packaging is unavailable. A package holds the built app, `xrb-host` renamed to
the app, the selected plugins (from their `bin/`) and `xrb-app.json` with the providers it starts with.
Packages land in the workspace's `builds/`.

Render an app's icon (`icon.png` in the app's folder) with the app itself:

```text
node packages/app-icon/src/cli.ts render --app <built app folder> --out <app folder>/icon.png
```

<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/separator-dark.svg"><img src="docs/assets/readme/separator.svg" alt="" width="280"></picture></p>

## Develop

Layout:

| Path | What |
|---|---|
| `native/host` | `xrb-host.exe`: CEF off-screen browser → frame on the display; providers for display, input and platform; host channel WebSocket to the page |
| `native/plugin-sdk` | `xrb_plugin.h`: the C ABI between the host and its plugins |
| [`packages/sdk`](packages/sdk/README.md) | `@xr-build/sdk`: stereo rig, hand input, pointer emulation for three.js |
| [`packages/ui-kit`](packages/ui-kit/README.md) | `@xr-build/ui-kit`: 3D controls on the hand interaction core |
| `packages/app-icon` | `@xr-build/app-icon`: default app icon, `.ico`, rendering an app's own icon |
| `packages/control-panel` | `@xr-build/control-panel`: the control panel (Node server + browser UI) |
| `templates/` | the new workspace and the new app the panel creates |
| `tools/` | `fetch-deps`, `name-guard`, `worktree`, `pr-automation`, `repo-governance`, `preview-readme`, `add-to-start.vbs` |
| `config/` | `github-repository-governance.json`: repository settings as code |
| `.github/` | CI, the bot workflows, the PR template |
| `openspec/` | the plan: specs and changes |

Tests:

```text
native/host/build/Release/host-tests.exe
pnpm test
```

Keep names out of the core: no vendor, product, client or person names in code, identifiers, constants,
paths, package names, docs or specs (the rule in `.claude/CLAUDE.md` and `openspec/config.yaml`). `pnpm check:names`
enforces it: it fails when a tracked file, path or package name holds a banned name. The banned names exist
only as hashes (`tools/name-guard/banned.sha256`), never as a plain list. `pnpm names add <name>` bans one more
(`--exact` for a name whose lower-case form is an ordinary word); commit the changed hash file. Enable the
pre-commit check once per clone:

```text
pnpm hooks
```

Preview the README as GitHub renders it, in your browser (needs `gh`):

```text
pnpm preview:readme
```

### Changes and pull requests

`main` takes changes only through a squash-merged PR that passes the `CI required` check. Each task works in its own
worktree, which links the primary checkout's `third_party/` instead of fetching CEF again:

```text
pnpm worktree add fix/hand-jitter      # .worktrees/hand-jitter on a new branch from origin/main
pnpm worktree sweep                    # every task worktree: dirty / active / merged / closed / unknown
pnpm worktree sweep --apply            # remove the merged, clean ones
```

A change that needs a plan starts as a draft PR holding only its OpenSpec change, linked in the PR body's Automation
block; the code follows in the same PR once the plan is approved. When the PR is marked ready, the repo bot archives
the change in the PR (specs synced), and CI's `Delivery` job turns green. Documentation-only PRs that link no change
merge by themselves once CI passes (the `no-auto-merge` label opts out). Every night CI runs every job on `main`; a
failure opens a draft `fix/nightly-<date>` PR. The full process for agents is `.claude/skills/change-delivery/SKILL.md`.

Repository settings, the `main` ruleset and the workflow labels are declared in
`config/github-repository-governance.json`; a weekly workflow reports drift in an issue. Change them in a PR, then:

```text
pnpm governance check
pnpm governance apply --confirm apply-xr-build-governance
```

**Repo bot.** The bot workflows run as a GitHub App installed on this repository only, with repository permissions
Contents, Pull requests and Issues (read and write), Administration and Metadata (read), and no webhook. Its id is
the Actions variable `XRB_BOT_APP_ID` and a private key the secret `XRB_BOT_PRIVATE_KEY`; the `Bot probe` workflow
checks both. To rotate the key, generate a new one on the App's page, replace the secret, and delete the old key.

<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/separator-dark.svg"><img src="docs/assets/readme/separator.svg" alt="" width="280"></picture></p>

## Troubleshooting

- **No projects in the panel** — the panel reads the workspace (`XRB_HOME` or `%USERPROFILE%\.xr-build`,
  shown in its top bar); create it there or point `XRB_HOME` at yours.
- **An app build stops with "XRB_CORE is not set"** — build it from the panel, or set `XRB_CORE` to this repo.
- **`fetch-deps`: source not found** — a plugin's local source is missing or elsewhere; set its `XRB_*` path.
- **`fetch-deps`: SHA-256 mismatch** — the local source is on a different version than the lock.
  Check out the pinned version, or re-pin with `--update-lock` if the upgrade is intended.
- **A provider is missing in the panel or `--list-plugins`** — Rebuild host; `--list-plugins` also
  reports plugin DLLs it rejected and why.
- **Display stays in 3D after a crash** — a host was killed with `/F`; start and close a host
  cleanly once.
- **Only one host at a time** — a second host exits; close the first one.

<br>

<p align="center">
  <picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/waves-dark.svg"><img src="docs/assets/readme/waves.svg" alt="" width="100%"></picture>
</p>

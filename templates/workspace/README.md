# XR Build workspace

Projects and plugins for XR Build, kept apart from the XR Build core. Keep this folder in your own git repo.

- `projects/<section>/<name>/`: projects (a folder with an `xrb-project.json`) in the panel's sections; `projects/Unsorted/`
  holds projects in no section, `projects/archive/` archived ones.
- `plugins/<name>/`: plugins (a native CMake project and/or a packager package).
- `xrb-panel.json`: the panel's project list layout.
- Not versioned (`.gitignore`): `plugins/*/bin/` (built plugins), `third_party/` (`pnpm fetch-deps --workspace` in the
  core), `builds/` (packages), `node_modules/`, `dist/`, `build/`, `jsconfig.json`.

The control panel finds this folder through `XRB_HOME`, or at `%USERPROFILE%\.xr-build`.

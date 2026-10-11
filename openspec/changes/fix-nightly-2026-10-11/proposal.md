## Why

The nightly CI run on main failed; this change finds the cause and fixes it.

Nightly CI on `main` failed at c0a8b25: https://github.com/timurproko/xr-build/actions/runs/38131329176

### Node tests

Failed step: Run pnpm -r --no-bail --if-present test

```text
packages/control-panel test: ℹ tests 62
packages/control-panel test: ℹ suites 0
packages/control-panel test: ℹ pass 61
packages/control-panel test: ℹ fail 0
packages/control-panel test: ℹ cancelled 0
packages/control-panel test: ℹ skipped 1
packages/control-panel test: ℹ todo 0
packages/control-panel test: ℹ duration_ms 12809.5267
packages/control-panel test: Done
packages/ui-kit test$ node --test "test/**/*.test.ts"
packages/ui-kit test: ✔ button: the cap follows the fingertip in, clicks at the press depth, keeps the press through a 1.5 cm drift, releases on retract (25.3853ms)
packages/ui-kit test: ✔ button: a 1 cm off-centre poke outside the visible edge still registers (5.2114ms)
packages/ui-kit test: ✔ button: the mouse clicks and releases it with source mouse (4.5671ms)
packages/ui-kit test: ✔ switch: a poke flips it each time, with the source (2.5855ms)
packages/ui-kit test: ✔ segmented: the segment under the fingertip is selected; between two, the nearer one (8.5311ms)
packages/ui-kit test: ✔ slider: pinch-drag gives grab (pinch), change values, release (pinch) (5.7399ms)
packages/ui-kit test: ✔ slider: touch-drag pushes the handle and slides; lifting lets go (5.7754ms)
packages/ui-kit test: ✔ slider: the mouse jumps the handle to the track and drags it; a stepped slider snaps (7.0193ms)
packages/ui-kit test: ✔ dial: a pinch at the rim turns it by the angle swept; release ends the grab (7.0074ms)
packages/ui-kit test: ✔ dial: the mouse turns it with a straight drag (up or right = up), not an arc (4.8793ms)
packages/ui-kit test: ✔ trackball: a hand inside the sphere grabs and turns it, leaving releases it (23.3305ms)
packages/ui-kit test: ✔ dialog: opens lifted toward the viewer, its Close button closes it with the source, hidden once shut (9.4878ms)
packages/ui-kit test: ✔ dialog: while open, the glass takes the mouse, so a button behind it does not light up or click (5.3689ms)
packages/ui-kit test: ✔ fade: a disabled control goes grey but stays opaque; enabled, its colours come back (6.9864ms)
packages/ui-kit test: ✔ disabling a slider mid-drag releases it, keeps the value and ignores further input (5.7857ms)
packages/ui-kit test: ℹ tests 15
packages/ui-kit test: ℹ suites 0
packages/ui-kit test: ℹ pass 15
packages/ui-kit test: ℹ fail 0
packages/ui-kit test: ℹ cancelled 0
packages/ui-kit test: ℹ skipped 0
packages/ui-kit test: ℹ todo 0
packages/ui-kit test: ℹ duration_ms 377.9572
packages/ui-kit test: Done
 ERR_PNPM_RECURSIVE_FAIL  
Summary: 1 fails, 8 passes
D:\a\xr-build\xr-build\tools\worktree:
 ERROR  @xr-build/worktree@0.0.0 test: `node --test`
Exit status 1
##[error]Process completed with exit code 1.
```

### CI required

Failed step: Run echo "$RESULTS"

```text
Image: ubuntu-24.04
Version: 20261004.327.1
Included Software: https://github.com/actions/runner-images/blob/ubuntu24/20261004.327/images/ubuntu/Ubuntu2404-Readme.md
Image Release: https://github.com/actions/runner-images/releases/tag/ubuntu24%2F20261004.327
##[endgroup]
##[group]GITHUB_TOKEN Permissions
Contents: read
Metadata: read
##[endgroup]
Secret source: Actions
Cache mode: write
Prepare workflow directory
Prepare all required actions
Complete job name: CI required
##[group]Run echo "$RESULTS"
echo "$RESULTS"
# skipped = not needed for these changes (or a draft); anything else but success fails the check.
if echo "$RESULTS" | grep -qE '"(failure|cancelled)"'; then exit 1; fi
shell: /usr/bin/bash -e {0}
env:
  RESULTS: [
  "success",
  "success",
  "success",
  "success",
  "skipped",
  "failure",
  "success"
]
##[endgroup]
[
  "success",
  "success",
  "success",
  "success",
  "skipped",
  "failure",
  "success"
]
##[error]Process completed with exit code 1.
```

## What Changes

- To be written once the cause is known.

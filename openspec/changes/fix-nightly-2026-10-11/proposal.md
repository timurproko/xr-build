## Why

The nightly CI run on main failed; this change finds the cause and fixes it.

Nightly CI on `main` failed at c0a8b25: https://github.com/timurproko/xr-build/actions/runs/38131329176

### Node tests

Failed step: Run pnpm -r --no-bail --if-present test

```text
tools/worktree test: ✖ throwaway: fails on purpose to exercise nightly triage (3.4817ms)
tools/worktree test: ✖ failing tests:
...
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

## What Changes

- To be written once the cause is known.

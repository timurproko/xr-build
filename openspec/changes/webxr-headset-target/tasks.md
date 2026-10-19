# Tasks

## 1. SDK: WebXR backend

- [ ] 1.1 Backend selection in `Xrb` (host, then WebXR, then desktop; design D1) with `xr` options (mode, button, panel); verify with `node --test` cases using a stubbed `navigator.xr` for each of the three paths
- [ ] 1.2 Session lifecycle: Enter button, `enterXR()` / `exitXR()`, `setAnimationLoop`, render through the XR camera, view stereo and not switchable, pointer emulation off in a session (D2); verify with tests on a stubbed session and the template app entering a session in a desktop WebXR emulator
- [ ] 1.3 Joint mapping 25 -> 21 keypoints and per-frame push into `HandInput` with 0 ms prediction (D3); verify with `node --test` cases for the mapping table, stable ids per input source, and one `pinchstart` / `pinchend` from recorded joint frames
- [ ] 1.4 Virtual panel anchor, its `DisplayInfo`, `recenter()`, and the panel frame transform (D4); verify with `node --test` cases for the 7.6 units per metre scenario and recenter placing the panel in front of a new head pose
- [ ] 1.5 Template app uses `xrb.setAnimationLoop`, and the SDK warns once when a session runs with no animation loop; verify the template builds and still runs in `xrb-host`

## 2. Packager contract

- [ ] 2.1 `Packager.target` in `packagers.ts` (D5): host by default, `webxr` build options without runtime and plugins; verify with `node --test` cases for discovery of both targets and the options a `webxr` fixture packager receives

## 3. Control panel

- [ ] 3.1 Manifest `target` read and written under the existing settings rules; verify with `node --test` cases: absent means host, a save writes `webxr`, the changed-on-disk refusal still applies
- [ ] 3.2 Settings Target selector, Platform list filtered by target, host-only controls hidden, "Open in browser" (D6); verify in the panel with the fixture packager present
- [ ] 3.3 Package build for `webxr` projects skips the host checks and passes the D5 options; verify with a `node --test` case where the fixture packager writes to `builds/`

## 4. Docs and checks

- [ ] 4.1 SDK README and `.claude/CLAUDE.md` describe the two targets and the virtual panel in neutral words; verify `pnpm check:names` passes
- [ ] 4.2 Run `pnpm test` and `pnpm check:names`; verify both pass

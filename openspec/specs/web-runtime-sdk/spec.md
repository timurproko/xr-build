# web-runtime-sdk Specification

## Purpose
`@xr-build/sdk` is the JavaScript library that lets a three.js application render in 3D on a stereo display and react to hand input with minimal changes (`createXrb()`). It runs unchanged in an ordinary desktop browser during development.

## Requirements

### Requirement: Stereo camera rig
The SDK SHALL render a given three.js scene and camera as an off-axis stereo pair into the two halves of the canvas, using the host's eye positions and display geometry. The app's existing camera SHALL keep acting as the "head" camera for raycasting, labels and controls.

#### Scenario: Existing app adopts the rig
- **WHEN** an app replaces its single `renderer.render(scene, camera)` call with the SDK's `xrb.render(scene, camera)`
- **THEN** the app renders in 3D on the 3D display without other changes to its scene setup

#### Scenario: Head-coupled perspective
- **WHEN** the viewer moves sideways
- **THEN** content behind the panel plane shifts opposite to content in front of it, consistent with the physical panel acting as a window

### Requirement: Scene-to-panel mapping
The SDK SHALL let an app declare how its scene units map to the physical panel: a scale, plus the scene point at the panel centre. Hand positions and eye positions SHALL be converted into scene space through that mapping.

#### Scenario: App in arbitrary units
- **WHEN** an app declares that 1 metre of panel equals 7.6 scene units
- **THEN** a hand 10 cm in front of the panel centre appears 0.76 scene units in front of the declared scene centre

### Requirement: Smoothed hand input
The SDK SHALL expose tracked hands with ID, handedness, keypoints, pinch, grab and palm frame, also in scene space. Keypoints SHALL be smoothed with a velocity-adaptive filter and predicted forward to the display time; the app can tune or disable smoothing and prediction.

#### Scenario: Hand held still
- **WHEN** a hand is held still in front of the display
- **THEN** the rendered fingertip jitter is below 3 mm RMS

#### Scenario: Fast movement
- **WHEN** a hand moves at 1 m/s
- **THEN** the rendered fingertip lags the physical fingertip by no more than 3 cm

### Requirement: Hand lifecycle events
The SDK SHALL emit events when a hand appears or disappears and when a pinch or grab starts or ends, for every input provider, deriving pinch and grab from the keypoints when the provider does not supply them. A hand SHALL be reported lost only after a configurable grace period (default 400 ms) without data.

#### Scenario: Pinch start and end
- **WHEN** a tracked hand's index-thumb pinch begins and later ends
- **THEN** exactly one `pinchstart` and one `pinchend` event are emitted for that hand ID

#### Scenario: Provider without gestures
- **WHEN** the input provider declares no pinch and no grab capability and a hand pinches
- **THEN** the SDK still emits `pinchstart` and `pinchend`, computed from the keypoints

### Requirement: Contact interaction primitives
The SDK, with its UI kit, SHALL provide touch-free 3D controls driven by hand contact with box or sphere volumes: push button, toggle switch, continuous slider, stepped slider and trackball rotation, with tunable push depth, angle tolerance, hysteresis, cooldown and damping.

#### Scenario: Button press
- **WHEN** a fingertip enters a button volume and pushes past the configured push depth along the button's inward axis
- **THEN** the button fires one click, and fires no further clicks until the fingertip retracts and the cooldown elapses

#### Scenario: Trackball spin
- **WHEN** a hand moves across a trackball volume and then leaves
- **THEN** the object rotates in the direction of motion and keeps coasting with exponential damping

### Requirement: Pointer emulation for existing apps
The SDK SHALL be able to translate a hand into standard DOM pointer events on the app's canvas: a projected fingertip position for move, and pinch or push for down/up, so apps built on pointer or raycaster input work without changes to their input handling.

#### Scenario: Click on a 3D marker
- **WHEN** pointer emulation is enabled and the user pinches while their fingertip projects onto a clickable mesh
- **THEN** the app receives `pointerdown`/`pointerup`/`click` at that mesh's canvas position, as if a mouse had clicked it

### Requirement: Browser development mode
When no host is present, the SDK SHALL run in an ordinary browser: it renders mono or simulated side-by-side output, emulates head position with the mouse, and emulates hands from the mouse or keyboard or from a recorded hand stream.

#### Scenario: Developer runs the dev server
- **WHEN** an app using the SDK is opened at a local dev-server URL in a desktop browser
- **THEN** it renders and is fully interactive using mouse-emulated hands, with no native components installed

### Requirement: App configuration access
The SDK SHALL give the app the name of the platform provider it runs under and the parameters the station configured it with (`xrb.platform`), and SHALL notify the app when the station configures it again (`xrb.onPlatform`). Standalone and in a browser the name is empty.

#### Scenario: Read a configured value
- **WHEN** the app reads its configuration after startup under a station platform
- **THEN** it receives the parameters the station sent for this app

#### Scenario: Reconfigured while running
- **WHEN** the station sends new parameters while the app runs
- **THEN** the app's `onPlatform` listeners are called with the new parameters

### Requirement: Overlay guidance for DOM content
The SDK SHALL provide a way to show 2D panels (text, info cards) in 3D as textured planes at a chosen depth rendered for both eyes, because DOM elements outside the canvas are seen by one eye only in side-by-side mode.

#### Scenario: Info panel in stereo
- **WHEN** an app shows an info card through the SDK's panel facility
- **THEN** the card is visible to both eyes at the configured depth

### Requirement: Page performance reporting
The SDK SHALL report the page's performance to the host once per second over the host channel: frames per second, median frame time, camera-to-page hand latency (median over the last second) and render resolution per eye. The host SHALL also accept a heartbeat that carries only fps.

#### Scenario: Running in the host
- **WHEN** an SDK app runs in the host
- **THEN** the host receives a performance report every second with fps, frame time, hand latency and resolution

#### Scenario: Older page
- **WHEN** a page built with an earlier SDK sends the fps-only heartbeat
- **THEN** the host reads the fps and reports the other values as unknown

### Requirement: App icon view
Every SDK app SHALL answer the icon view: opened with `?xrb-icon=<size>` it shows only its icon subject on a transparent square of that size, navigable with `interactive` in the query. The SDK SHALL provide the icon request, a ready signal (`iconReady()`), PNG captures for an embedding page, and pause/resume on its request.

#### Scenario: SDK app without icon code
- **WHEN** an SDK app with no icon code is opened in the icon studio
- **THEN** its scene shows live on a transparent square, and Take saves it as the icon: in icon mode `xrb.render()` draws a square frame without the scene background, fog and hands, and `xrb.viewSize()` is that square

#### Scenario: Automatic ready signal
- **WHEN** an app built on `createXrb()` runs in icon mode
- **THEN** the SDK sends the ready signal after a short delay, unless the app opted out and sends it itself

#### Scenario: App frames its own icon
- **WHEN** an app answers the studio with its own capture function
- **THEN** the studio gets that capture; when several are registered, the last one on the page wins

#### Scenario: Pause from the studio
- **WHEN** the embedding page requests a pause
- **THEN** the app's animation frames are held until the page requests resume, and a capture during the pause draws its own frame and returns the paused view

#### Scenario: Unattended render
- **WHEN** the host renders the icon of an app that supports it (`--render-icon=`)
- **THEN** the app signals ready once its icon frame is complete, and the host saves a transparent PNG

#### Scenario: Capture from the studio
- **WHEN** the app runs in an iframe with `?xrb-icon=512&interactive` and the embedding page requests a capture
- **THEN** the app answers with a 512 x 512 PNG of the frame as currently shown, with transparency kept

### Requirement: View switch
The SDK SHALL follow the host's view: on a switch between 2D and 3D the canvas and cameras change between one view and two eyes side by side without app code, the live view is readable (`xrb.stereo`) and apps can subscribe (`xrb.onView`). An app can ask with `xrb.setStereo()`: a switchable host performs and confirms it, otherwise the SDK switches at once.

#### Scenario: Host switches
- **WHEN** the control panel switches a running app to 2D
- **THEN** the app's next frames are drawn as one view at the eye size, its view listeners are called once with 2D, and the hands and pointer keep working

#### Scenario: App switches
- **WHEN** an app calls `xrb.setStereo(true)` inside a host with a switchable session
- **THEN** the host switches and the app sees the 3D view once the host confirmed it

### Requirement: No stats overlay in apps
The SDK SHALL NOT draw any performance or diagnostics overlay in the app; no key, URL parameter or default turns one on. Performance is shown in the developer control panel instead.

#### Scenario: F2 in an app
- **WHEN** the user presses F2 in a running SDK app, or opens it with `?stats=1`
- **THEN** nothing is drawn over the app

### Requirement: WebXR headset runtime
When the page runs without a host and the browser offers an immersive WebXR session, the SDK SHALL let the app enter
the session from a user gesture (a default Enter button or `xrb.enterXR()`), render the app's scene for both eyes
through the WebXR renderer with the same `xrb.render(scene, camera)` call, and keep the desktop single-view fallback
when no session is offered. Passthrough SHALL be used when supported unless the app chooses otherwise.

#### Scenario: Same app on a headset
- **WHEN** an app built for a 3D display is opened in a headset browser engine with WebXR and the user presses Enter
- **THEN** the app's scene is shown in the headset in stereo without changes to the app's scene code

#### Scenario: Desktop browser without WebXR
- **WHEN** the same build is opened in a desktop browser that offers no immersive session
- **THEN** no Enter button is shown and the app renders one view as before

#### Scenario: Installed immersive app
- **WHEN** the page is opened with `?xrb-xr=enter` (an installed headset app's start address) or the browser grants a session after a navigation (`sessiongranted`)
- **THEN** the SDK enters the session without the user pressing Enter

### Requirement: Headset hands
In a WebXR session the SDK SHALL read the headset's tracked hand joints every frame, map them to the 21-keypoint hand
in the panel frame, and feed them to the same hand input, lifecycle events and interaction core as host hands,
deriving pinch and grab from the keypoints.

#### Scenario: Pinch on a headset
- **WHEN** a tracked hand on the headset pinches and releases
- **THEN** exactly one `pinchstart` and one `pinchend` are emitted for that hand

#### Scenario: ui-kit button pressed by a headset hand
- **WHEN** an index fingertip pushes a ui-kit button past its push depth in a headset session
- **THEN** the button fires one click, as it does on a 3D display

### Requirement: Virtual panel
In a WebXR session the SDK SHALL anchor a virtual panel in the room in front of the user at session start, with a
default size the app can override, and SHALL re-anchor it on `xrb.recenter()`. Scene-to-panel mapping and hand
positions SHALL use that panel's frame exactly as they use a physical panel's.

#### Scenario: Mapping kept
- **WHEN** an app declares that 1 metre of panel equals 7.6 scene units and runs in a headset session
- **THEN** a hand 10 cm in front of the virtual panel centre appears 0.76 scene units in front of the declared scene centre

#### Scenario: Recenter
- **WHEN** the user turns to face another wall and the app calls `xrb.recenter()`
- **THEN** the virtual panel and the app's content are placed in front of the user's new heading

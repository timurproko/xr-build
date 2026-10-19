// @xr-build/sdk: three.js on 3D displays with hand input (XR Build host).
//
//   const xrb = createXrb(renderer);           // after creating your WebGLRenderer
//   scene.add(xrb.handsObject);                // optional hand skeleton
//   function animate() { xrb.render(scene, camera); requestAnimationFrame(animate); }
//
// Inside xrb-host the page is shown in 3D and hands arrive from the cameras; in a
// normal browser the same code renders one view from the nominal viewer position. In a
// headset's browser engine with WebXR, Enter (or xrb.enterXR()) starts an immersive session:
// both eyes come from the headset and hands from its hand tracking (drive frames with
// xrb.setAnimationLoop, which works in all three).
import * as THREE from 'three';
import { HostChannel } from './channel.ts';
import { HandVisual } from './hand-visual.ts';
import { HandInput, type Hand, type HandEvent, type HandInputOptions } from './hands.ts';
import { Interactor, type InteractorOptions } from './interaction/core/interactor.ts';
import { MouseCursor } from './interaction/core/cursor.ts';
import { OneEuro } from './one-euro.ts';
import { DEFAULT_DISPLAY, getHostInfo, type DisplayInfo, type HostInfo } from './host.ts';
import { iconReady, iconRender, iconServing, serveIconCapture, type IconRequest } from './icon.ts';
import { PointerEmulation } from './pointer.ts';
import { ALL_CAPABILITIES, type HandCapabilities, type PagePerformance, type PlatformInfo, type StatusMessage, type Vec3 } from './protocol.ts';
import { toSceneHand, type SceneHand } from './scene-hands.ts';
import { nominalEyes, StereoRenderer, type EyePair, type PanelMapping } from './stereo.ts';
import { detectXrMode, eyesInPanel, headOf, rigMatrix, virtualDisplay, VirtualPanel, XrHands, type XrFrameLike, type XrMode, type XrOptions, type XrSessionLike, type XrSystemLike } from './webxr.ts';

export * from './protocol.ts';
export { HostChannel } from './channel.ts';
export { HandInput, KP, isValidHand, fingerCurl, DEFAULT_HAND_INPUT, type Hand, type HandEvent, type HandInputOptions } from './hands.ts';
export { toSceneHand, type SceneHand } from './scene-hands.ts';
export { HandVisual, DEFAULT_HAND_STYLE, type HandVisualStyle } from './hand-visual.ts';
export { Trackball, type TrackballAxis, type TrackballOptions } from './interaction/trackball.ts';
export { DotShell, icosphereVertices } from './interaction/dot-shell.ts';
export { GrabRotate, palmQuaternion, pinchCentre, nearestTarget, type SelectTarget } from './interaction/grab.ts';
export { smoothDamp } from './interaction/smooth-damp.ts';
export * from './interaction/core/index.ts';
export { DEFAULT_DISPLAY, getHostInfo, type DisplayInfo, type HostInfo } from './host.ts';
export { iconRender, iconReady, iconServing, serveIconCapture, type IconRequest, type IconStudioMessage } from './icon.ts';
export { OneEuro, DEFAULT_ONE_EURO } from './one-euro.ts';
export { PointerEmulation, projectToPanel, choosePointerHand } from './pointer.ts';
export { offAxisProjection, PanelFrame, StereoRenderer, NOMINAL_EYE, type PanelMapping } from './stereo.ts';
export { detectXrMode, VirtualPanel, XrHands, XR_JOINTS, XR_PANEL_DEFAULTS, type XrMode, type XrOptions, type XrPanelOptions } from './webxr.ts';

export interface XrbOptions {
  /** how panel metres map into the scene; default: panel in front of your camera */
  mapping?: PanelMapping;
  /** per-eye render resolution multiplier (1 = panel pixels) */
  resolutionScale?: number;
  /** turn hands into pointer events on the canvas (pinch = click/drag); default true */
  pointer?: boolean;
  hands?: HandInputOptions;
  /** shared interaction core: tuning overrides (see DEFAULT_TUNING) */
  interaction?: InteractorOptions;
  /** expected delay from rendering to the panel lighting up, for hand prediction */
  displayLatencyMs?: number;
  /**
   * Icon view (page opened with `?xrb-icon`): Xrb draws the scene square on a transparent
   * background, answers the icon studio, and tells the host the frame is ready after `readyMs`.
   * Set `autoReady: false` and call iconReady() yourself when the icon frame needs loading first.
   */
  icon?: { autoReady?: boolean; readyMs?: number };
  /** WebXR headset session (no host): session kind, Enter button, virtual panel size and placement */
  xr?: XrOptions;
}

/** Recommended WebGLRenderer options: no MSAA in side-by-side mode (the biggest GPU cost on a 3D display). */
export function rendererOptions(): THREE.WebGLRendererParameters {
  const host = getHostInfo();
  return { antialias: !host?.stereo, powerPreference: 'high-performance' };
}

/** The page's view: 3D (two eyes side by side, woven by the display) or 2D (one view, a plain picture). */
export interface XrbView {
  stereo: boolean;
  /** the host can switch at run time (its display has a switchable session); false in a browser, on a mono display and in a headset */
  switchable: boolean;
}

const navigatorXr = (): XrSystemLike | null => (globalThis as { navigator?: { xr?: XrSystemLike } }).navigator?.xr ?? null;

export class Xrb {
  readonly host: HostInfo | null;
  readonly display: DisplayInfo;
  readonly channel: HostChannel | null;
  readonly hands: HandInput;
  readonly view: StereoRenderer;
  readonly pointer: PointerEmulation | null;
  /** shared interaction core: register poke / pinch / grab / volume targets, updated before each render */
  readonly interaction: Interactor;
  /** add to your scene to see tracked hands */
  readonly handsObject = new HandVisual();
  /** add to your scene to see the mouse on a 3D display: a ring where the pointer lands (needs bindMouse) */
  readonly cursorObject = new MouseCursor();
  /** hands of the current frame (panel frame, metres) */
  currentHands: Hand[] = [];
  /** the same hands in scene space: keypoints, fingertip, pinch point and palm frame (same order) */
  sceneHands: SceneHand[] = [];
  /** eyes of the current frame (panel frame, metres) */
  currentEyes: EyePair = nominalEyes();
  /** frames per second measured by the page */
  fps = 0;
  private _stereo: boolean;
  private readonly viewListeners = new Set<(view: XrbView) => void>();
  /** CPU time of the last xrb.render call (both eyes), ms */
  renderMs = 0;
  /** eye smoothing: steady at rest, quick when the head moves (6 filters: L xyz, R xyz) */
  private readonly eyeFilters = Array.from({ length: 6 }, () => new OneEuro({ minCutoff: 1.0, beta: 6.0, dCutoff: 1.0 }));
  // Performance goes to the host (and from there to the control panel); the app draws none.
  private readonly deliveryMs: number[] = [];
  private readonly frameIntervals: number[] = [];
  private lastFrameAt = 0;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly displayLatencyMs: number;
  private frames = 0;
  private fpsSince = 0;
  private lastHeartbeat = 0;
  /** the page renders its icon (`?xrb-icon`), else null */
  readonly icon: IconRequest | null = iconRender();
  private readonly iconOptions: { autoReady: boolean; readyMs: number };
  private iconStartedAt = 0;
  private iconSignalled = false;
  /** the immersive session this browser offers (known shortly after start), null without one or under a host */
  xrMode: XrMode | null = null;
  private readonly xrOptions: XrOptions;
  private readonly xrPanel: VirtualPanel;
  private readonly xrHands = new XrHands();
  /** parent of the XR camera: reference space -> scene, so the virtual panel lands where the mapping puts the panel */
  private readonly xrRig = new THREE.Object3D();
  private readonly xrCamera = new THREE.PerspectiveCamera();
  private xrButton: HTMLButtonElement | null = null;
  private xrFrames = 0;

  constructor(renderer: THREE.WebGLRenderer, options: XrbOptions = {}) {
    this.renderer = renderer;
    this.host = getHostInfo();
    this._stereo = !!this.host?.stereo;
    this.xrOptions = options.xr ?? {};
    this.xrPanel = new VirtualPanel(this.xrOptions.panel);
    this.xrRig.matrixAutoUpdate = false;
    this.xrRig.add(this.xrCamera);
    this.display = this.host?.display ?? (this.xrOptions.panel ? virtualDisplay(DEFAULT_DISPLAY, this.xrOptions.panel) : DEFAULT_DISPLAY);
    this.displayLatencyMs = options.displayLatencyMs ?? 8;
    this.channel = this.host ? new HostChannel(this.host) : null;
    this.hands = new HandInput(options.hands);
    this.interaction = new Interactor(options.interaction);
    this.channel?.onHands((m) => {
      this.hands.push(m, this.channel!.hostToPage(m.captureTimeMs));
      this.deliveryMs.push(this.host!.hostNow() - m.captureTimeMs);
      if (this.deliveryMs.length > 60) this.deliveryMs.shift();
    });
    const eye = this.host?.eye ?? { width: innerWidth, height: innerHeight };
    this.view = new StereoRenderer(renderer, this.display, this._stereo, eye, { mapping: options.mapping, resolutionScale: options.resolutionScale });
    // The host's view can change while the app runs (control panel "2D mode", or setStereo below):
    // the page is resized to match and the canvas follows here, so apps need no code for it.
    this.channel?.onView((v) => {
      this.view.setEyeSize(v.width, v.height);
      this.applyView(v.stereo);
    });
    this.iconOptions = { autoReady: options.icon?.autoReady ?? true, readyMs: options.icon?.readyMs ?? 1000 };
    this.pointer = options.pointer === false || this.icon ? null : new PointerEmulation({ element: renderer.domElement });
    if (this.icon) this.startIcon(this.icon.size);
    this.setSize();
    if (!this.host && !this.icon) void this.detectXr();
  }

  /** true: the page shows two eyes side by side in 3D (or a headset session runs); false: one view in 2D. Can change at run time (onView). */
  get stereo(): boolean {
    return this._stereo || this.presenting;
  }

  /** true while a WebXR headset session runs. */
  get presenting(): boolean {
    return !!this.renderer.xr?.isPresenting;
  }

  /**
   * Drives the app's frames: the browser's animation frames, or the headset's while a session runs
   * (a page's own requestAnimationFrame stops in a session). Pass null to stop.
   */
  setAnimationLoop(fn: ((timeMs: number) => void) | null): void {
    this.renderer.setAnimationLoop(fn);
  }

  /** Starts the headset session; call it from a user gesture (the Enter button does). */
  async enterXR(): Promise<void> {
    const xr = navigatorXr();
    if (!xr || !this.xrMode || this.presenting) return;
    const session = await xr.requestSession(this.xrMode, { optionalFeatures: ['hand-tracking'] });
    this.renderer.xr.enabled = true;
    this.renderer.xr.setReferenceSpaceType('local');
    this.xrPanel.reset();
    await this.renderer.xr.setSession(session as unknown as XRSession);
    // After the renderer's own end handler, so the page is no longer presenting when the view is reported.
    session.addEventListener('end', () => this.xrEnded());
    // The headset moved its origin (the user recentred the headset): place the panel in front of them again.
    this.renderer.xr.getReferenceSpace()?.addEventListener('reset', () => this.recenter());
    if (this.xrButton) this.xrButton.style.display = 'none';
    this.xrFrames = 0;
    setTimeout(() => {
      if (this.presenting && this.xrFrames === 0) console.warn('[xrb] the headset session shows nothing: drive frames with xrb.setAnimationLoop(fn), requestAnimationFrame stops in a session');
    }, 3000);
    this.emitView();
  }

  /** Ends the headset session. */
  async exitXR(): Promise<void> {
    await (this.renderer.xr.getSession() as unknown as XrSessionLike | null)?.end();
  }

  /** Places the virtual panel in front of the user again (next frame). */
  recenter(): void {
    this.xrPanel.reset();
  }

  private async detectXr(): Promise<void> {
    this.xrMode = await detectXrMode(navigatorXr(), this.xrOptions.mode);
    if (this.xrMode && this.xrOptions.button !== false && typeof document !== 'undefined') this.addXrButton();
  }

  private addXrButton(): void {
    const b = document.createElement('button');
    b.textContent = 'Enter';
    b.title = 'Show the app in the headset';
    Object.assign(b.style, {
      position: 'fixed', left: '50%', bottom: '24px', transform: 'translateX(-50%)', zIndex: '2147483647',
      padding: '12px 28px', border: '1px solid #ffffff55', borderRadius: '24px', background: '#000000aa',
      color: '#fff', font: '600 16px system-ui, sans-serif', cursor: 'pointer',
    });
    b.addEventListener('click', () => void this.enterXR().catch((e) => console.warn('[xrb] could not start the headset session:', e)));
    document.body.appendChild(b);
    this.xrButton = b;
  }

  private xrEnded(): void {
    this.renderer.xr.enabled = false;
    if (this.xrButton) this.xrButton.style.display = '';
    this.setSize();
    this.emitView();
  }

  private emitView(): void {
    const view: XrbView = { stereo: this.stereo, switchable: this.switchable };
    for (const fn of this.viewListeners) fn(view);
  }

  /** true when the host can switch between 2D and 3D while the app runs (its display has a switchable session). */
  get switchable(): boolean {
    return !!this.host?.switchable;
  }

  /**
   * Shows the app in 3D (side by side) or in 2D (one view). On a switchable display the host switches it
   * and resizes the page, then confirms with a view message; in a browser the canvas changes at once.
   */
  setStereo(stereo: boolean): void {
    if (this.presenting) return;  // a headset always shows both eyes
    if (this.channel && this.switchable) {
      this.channel.sendSetView(stereo);
      return;
    }
    this.applyView(stereo);
  }

  /** Called after every view change (2D <-> 3D) with the new view; returns an unsubscribe function. */
  onView(fn: (view: XrbView) => void): () => void {
    this.viewListeners.add(fn);
    return () => this.viewListeners.delete(fn);
  }

  private applyView(stereo: boolean): void {
    const changed = stereo !== this._stereo;
    this._stereo = stereo;
    this.view.setStereo(stereo);
    this.setSize();
    if (changed) this.emitView();
  }

  /** Size of one eye's view in CSS pixels: use it for your camera aspect and UI layout. */
  viewSize(): { width: number; height: number } {
    if (this.icon) return { width: this.icon.size, height: this.icon.size };
    return this.view.viewSize();
  }

  /** Sizes the canvas for the host (2 eyes side by side) or the browser window. Call on resize. */
  setSize(): void {
    if (this.icon) {
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(this.icon.size, this.icon.size);
      return;
    }
    if (this.presenting) return;  // the headset sizes its own views
    if (!this.host) this.view.setEyeSize(innerWidth, innerHeight);
    this.view.applyCanvasSize();
  }

  /** Input provider status from the host: `starting`, `running`, `needs-setup`, `device-missing`, `failed` (null in a browser). */
  get handStatus(): StatusMessage | null {
    return this.channel?.status ?? null;
  }

  /**
   * What the input provider tracks natively (from its newest hand frame). Gestures work either way: without
   * pinch or grab the SDK computes them from the keypoints. All true until the first frame and in a browser.
   */
  get handCapabilities(): HandCapabilities {
    return this.channel?.hands?.capabilities ?? ALL_CAPABILITIES;
  }

  /**
   * The station runtime the app runs under and its configure parameters (e.g. per-installation
   * settings). `name` is "" standalone and in a browser; `params` updates when the station configures
   * the app (onPlatform).
   */
  get platform(): PlatformInfo {
    const p = this.channel?.platform;
    if (p) return { name: p.name, params: p.params };
    return { name: this.host?.platform?.name ?? '', params: this.host?.platform?.params ?? {} };
  }

  /** Called when the station sends (new) parameters; returns an unsubscribe function. */
  onPlatform(fn: (platform: PlatformInfo) => void): () => void {
    return this.channel?.onPlatform((p) => fn({ name: p.name, params: p.params })) ?? (() => {});
  }

  on(fn: (e: HandEvent) => void): () => void {
    return this.hands.on(fn);
  }

  /** Keypoints of every current hand in world coordinates (same order as `currentHands`). */
  handsInScene(): THREE.Vector3[][] {
    return this.currentHands.map((h) => h.keypoints.map((p) => this.view.panel.pointToWorld(p, new THREE.Vector3())));
  }

  /** Scene units per physical metre on the panel, for sizing interaction radii. */
  get metre(): number {
    return this.view.panel.scale;
  }

  /**
   * Drives the interaction targets with the mouse too (plain browser or a 3D display): hover on
   * mouse-over, press / take on button down, drag while held, release on button up. Returns an unbind function.
   */
  bindMouse(): () => void {
    // The page maps the mouse across the whole canvas to the whole panel (mono or side by side), so
    // (u, v) is a point on the glass; the ray runs from the viewer's eye through it. This matches what
    // the eye sees on a 3D display (off-axis view) and in the browser (the same view from the nominal eye).
    return this.interaction.bindMouse(this.renderer.domElement, (u, v) => {
      const d = this.display;
      const glass = this.view.panel.pointToWorld([(u - 0.5) * d.widthM, (0.5 - v) * d.heightM, 0], new THREE.Vector3());
      const l = this.currentEyes.left, r = this.currentEyes.right;
      const eye = this.view.panel.pointToWorld([(l[0] + r[0]) / 2, (l[1] + r[1]) / 2, (l[2] + r[2]) / 2], new THREE.Vector3());
      return new THREE.Ray(eye, glass.sub(eye).normalize());
    });
  }

  /** Converts a panel-frame point (metres) to world coordinates for the current frame. */
  toScene(p: Vec3, out = new THREE.Vector3()): THREE.Vector3 {
    return this.view.panel.pointToWorld(p, out);
  }

  /** Renders one frame: updates eyes, hands and pointer, then draws both eyes. */
  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera): void {
    if (this.icon) {
      this.renderIcon(scene, camera);
      return;
    }
    const now = performance.now();
    const xr = this.presenting;
    const e = this.channel?.eyes;
    if (xr) {
      this.readXr(now);
    } else if (e) {
      const f = this.eyeFilters;
      const L = e.left.map((v, i) => f[i].filter(v, now)) as Vec3;
      const R = e.right.map((v, i) => f[3 + i].filter(v, now)) as Vec3;
      this.currentEyes = { left: L, right: R };
    }
    // Headset joints are already predicted to the frame's display time by the headset.
    this.currentHands = this.hands.sample(xr ? now : now + this.displayLatencyMs);
    // The panel frame follows the camera, so update it before using it for hands.
    this.view.panel.update(this.view.mapping, camera);
    this.sceneHands = this.currentHands.map((h) => toSceneHand(h, this.view.panel));
    this.interaction.update(this.sceneHands, this.metre);
    if (this.cursorObject.parent) {
      const l = this.currentEyes.left, r = this.currentEyes.right;
      const eye = this.view.panel.pointToWorld([(l[0] + r[0]) / 2, (l[1] + r[1]) / 2, (l[2] + r[2]) / 2], new THREE.Vector3());
      this.cursorObject.update(this.interaction, this.view.panel, eye, now, this.lastFrameAt > 0 ? (now - this.lastFrameAt) / 1000 : 1 / 60);
    }
    this.handsObject.update(this.currentHands, this.view.panel);
    const l = this.currentEyes.left, r = this.currentEyes.right;
    this.pointer?.update(this.currentHands, [(l[0] + r[0]) / 2, (l[1] + r[1]) / 2, (l[2] + r[2]) / 2], this.display);
    const t0 = performance.now();
    if (xr) this.drawXr(scene, camera);
    else this.view.render(scene, camera, this.currentEyes);
    this.renderMs = performance.now() - t0;

    if (this.lastFrameAt > 0) {
      this.frameIntervals.push(now - this.lastFrameAt);
      if (this.frameIntervals.length > 120) this.frameIntervals.shift();
    }
    this.lastFrameAt = now;
    this.frames++;
    if (now - this.fpsSince >= 1000) {
      this.fps = (this.frames * 1000) / (now - this.fpsSince);
      this.frames = 0;
      this.fpsSince = now;
    }
    if (now - this.lastHeartbeat >= 500) {
      if (this.channel) this.channel.sendHeartbeat(this.performance());
      this.lastHeartbeat = now;
    }
  }

  /** The page's current performance, as reported to the host. */
  performance(): PagePerformance {
    const eye = this.view.viewSize();
    const scale = this.view.resolutionScale;
    // Only samples from about the last second (latency arrives at the tracking rate).
    const frames = this.frameIntervals.slice(-Math.max(1, Math.round(this.fps) || 60));
    const latency = this.deliveryMs.slice(-Math.max(1, Math.round(this.channel?.hands?.trackingHz ?? 60)));
    return {
      fps: this.fps,
      frameMs: median(frames) ?? 0,
      latencyMs: median(latency),
      eyeWidth: eye.width * scale,
      eyeHeight: eye.height * scale,
    };
  }

  /** Headset frame: anchors the virtual panel, then reads the eyes and hands in its frame. */
  private readXr(now: number): void {
    this.xrFrames++;
    const frame = this.renderer.xr.getFrame() as unknown as XrFrameLike | null;
    const space = this.renderer.xr.getReferenceSpace();
    if (!frame || !space) return;
    const pose = frame.getViewerPose(space);
    if (pose && !this.xrPanel.anchored) {
      const head = headOf(pose);
      this.xrPanel.anchor(head.position, head.quaternion);
    }
    if (!this.xrPanel.anchored) return;
    if (pose) this.currentEyes = eyesInPanel(pose, this.xrPanel);
    this.hands.push(this.xrHands.read(frame, space, this.xrPanel, now), now);
  }

  /** Both eyes through the headset; the XR camera's parent puts the virtual panel where the mapping puts the panel. */
  private drawXr(scene: THREE.Scene, camera: THREE.PerspectiveCamera): void {
    this.view.syncHeadCamera(camera);
    const panel = this.view.panel;
    rigMatrix(panel.toWorld, this.xrPanel, this.xrRig.matrix);
    this.xrRig.updateMatrixWorld(true);
    // The headset's projections are in metres; the rig scales metres to scene units.
    this.xrCamera.near = camera.near / panel.scale;
    this.xrCamera.far = camera.far / panel.scale;
    const passthrough = this.xrMode === 'immersive-ar' && this.xrOptions.passthroughBackground !== false;
    const background = scene.background, clearAlpha = this.renderer.getClearAlpha();
    if (passthrough) {
      scene.background = null;
      this.renderer.setClearAlpha(0);
    }
    this.renderer.render(scene, this.xrCamera);
    if (passthrough) {
      scene.background = background;
      this.renderer.setClearAlpha(clearAlpha);
    }
  }

  /** Icon view: the canvas alone at the top left, transparent page. */
  private startIcon(size: number): void {
    const canvas = this.renderer.domElement;
    for (const el of [document.documentElement, document.body]) {
      el.style.background = 'transparent';
      el.style.margin = '0';
      el.style.overflow = 'hidden';
    }
    canvas.style.position = 'fixed';
    canvas.style.left = canvas.style.top = '0';
    canvas.style.zIndex = '2147483647';
    canvas.style.width = canvas.style.height = `${size}px`;
    this.renderer.setClearColor(0x000000, 0);
  }

  /** One square frame of the scene without its background, fog and hands. */
  private renderIcon(scene: THREE.Scene, camera: THREE.PerspectiveCamera): void {
    const draw = () => {
      const { background, fog } = scene;
      const hands = this.handsObject.visible;
      scene.background = null;
      scene.fog = null;
      this.handsObject.visible = false;
      if (camera.aspect !== 1) {
        camera.aspect = 1;
        camera.updateProjectionMatrix();
      }
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.render(scene, camera);
      scene.background = background;
      scene.fog = fog;
      this.handsObject.visible = hands;
    };
    draw();
    const icon = this.icon!;
    if (icon.interactive) {
      // The app's own serveIconCapture (custom framing) takes precedence.
      if (!iconServing()) serveIconCapture(this.renderer.domElement, draw, icon.size);
    } else if (this.iconOptions.autoReady && !this.iconSignalled) {
      const now = performance.now();
      if (!this.iconStartedAt) this.iconStartedAt = now;
      if (now - this.iconStartedAt >= this.iconOptions.readyMs) {
        this.iconSignalled = true;
        iconReady();
      }
    }
  }

  dispose(): void {
    this.channel?.close();
    this.xrButton?.remove();
    void this.exitXR();
  }
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export function createXrb(renderer: THREE.WebGLRenderer, options: XrbOptions = {}): Xrb {
  return new Xrb(renderer, options);
}


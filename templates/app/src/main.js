// A new XR Build app: three cubes at different depths, click or pinch to select one.
// Runs in xrb-host (3D display, hands) and in a browser.
import * as THREE from 'three';
import { createXrb, rendererOptions } from '@xr-build/sdk';

const renderer = new THREE.WebGLRenderer(rendererOptions());
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);
const xrb = createXrb(renderer);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#0b0f14');
scene.add(new THREE.HemisphereLight('#cfe3ff', '#202833', 2.0));
const sun = new THREE.DirectionalLight('#ffffff', 2.0);
sun.position.set(2, 4, 3);
scene.add(sun);
scene.add(xrb.handsObject);

const { width, height } = xrb.viewSize();
const camera = new THREE.PerspectiveCamera(38, width / height, 0.05, 100);
camera.position.set(0, 0, 6);

// In front of, on and behind the display plane.
const colors = ['#f08a24', '#5bd18b', '#2f6fdf'];
const cubes = [-1.2, 0, 1.2].map((z, i) => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.8, 0.8), new THREE.MeshStandardMaterial({ color: colors[i] }));
  m.position.set((i - 1) * 1.4, 0, z);
  m.userData.base = colors[i];
  scene.add(m);
  return m;
});

// Click or pinch: the raycaster uses the canvas rect, so mouse and hands behave the same.
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
renderer.domElement.addEventListener('click', (e) => {
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.intersectObjects(cubes)[0];
  for (const c of cubes) c.material.color.set(c === hit?.object ? '#ffffff' : c.userData.base);
});

addEventListener('resize', () => {
  xrb.setSize();
  const s = xrb.viewSize();
  camera.aspect = s.width / s.height;
  camera.updateProjectionMatrix();
});

function animate(t) {
  cubes.forEach((c, i) => (c.rotation.y = (t / 1000) * (0.3 + i * 0.1)));
  xrb.render(scene, camera);
  requestAnimationFrame(animate);
}
requestAnimationFrame(animate);

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { iconRender, iconServing, serveIconCapture, type IconStudioEnv } from '../src/icon.ts';

test('reads the icon request from the URL', () => {
  assert.equal(iconRender(''), null);
  assert.deepEqual(iconRender('?xrb-icon=512'), { size: 512, interactive: false });
  assert.deepEqual(iconRender('?a=1&xrb-icon=256&interactive'), { size: 256, interactive: true });
  assert.deepEqual(iconRender('?xrb-icon=bad'), { size: 512, interactive: false });
});

function studio() {
  const sent: Array<{ message: any; origin: string }> = [];
  const parent = { postMessage: (message: unknown, origin: string) => sent.push({ message, origin }) };
  let listener: ((e: { data: unknown; source: unknown; origin: string }) => void) | null = null;
  const env: IconStudioEnv = {
    parent,
    addEventListener: (_t, fn) => (listener = fn),
    removeEventListener: () => (listener = null),
  };
  const send = (data: unknown, source: unknown = parent) => listener?.({ data, source, origin: 'http://127.0.0.1:5180' });
  return { env, parent, sent, send, listening: () => listener !== null };
}

test('answers a capture from the parent with a PNG of a freshly drawn frame', () => {
  const s = studio();
  const order: string[] = [];
  const png = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' });
  const canvas = { toBlob: (cb: (b: Blob | null) => void, type?: string) => { order.push(`toBlob ${type}`); cb(png); } };
  const stop = serveIconCapture(canvas, () => order.push('render'), 512, s.env);
  assert.deepEqual(s.sent[0].message, { type: 'xrb-icon:hello', size: 512, canPause: false });
  s.send({ type: 'xrb-icon:capture', id: 7 });
  assert.deepEqual(order, ['render', 'toBlob image/png'], 'drawn, then read in the same task');
  assert.deepEqual(s.sent[1], { message: { type: 'xrb-icon:png', id: 7, png }, origin: 'http://127.0.0.1:5180' });
  stop();
  assert.equal(s.listening(), false);
});

test('ignores other windows and other messages, reports failures', () => {
  const s = studio();
  let renders = 0;
  const canvas = { toBlob: (cb: (b: Blob | null) => void) => cb(null) };
  serveIconCapture(canvas, () => renders++, 512, s.env);
  s.send({ type: 'xrb-icon:capture', id: 1 }, { not: 'the parent' });
  s.send({ type: 'something-else', id: 2 });
  s.send(null);
  assert.equal(renders, 0);
  assert.equal(s.sent.length, 1, 'only the hello');
  s.send({ type: 'xrb-icon:capture', id: 3 });
  assert.equal(s.sent[1].message.type, 'xrb-icon:error');
  assert.equal(s.sent[1].message.id, 3);
});

test('does nothing when not embedded', () => {
  const env = { parent: null, addEventListener: () => assert.fail('no listener'), removeEventListener: () => {} };
  serveIconCapture({ toBlob: () => {} }, () => {}, 512, env as unknown as IconStudioEnv)();
});

test('pause holds animation frames back and resume runs them; capture still works', () => {
  const s = studio();
  const ran: string[] = [];
  const frames: FrameRequestCallback[] = [];
  const env = { ...s.env, requestAnimationFrame: (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; } };
  const canvas = { toBlob: (cb: (b: Blob | null) => void) => cb(new Blob(['x'], { type: 'image/png' })) };
  const stop = serveIconCapture(canvas, () => ran.push('render'), 512, env as IconStudioEnv);
  assert.equal(s.sent[0].message.canPause, true);
  const raf = () => env.requestAnimationFrame((t: number) => ran.push(`frame ${t}`));

  raf();
  assert.equal(frames.length, 1, 'not paused: passes through');
  s.send({ type: 'xrb-icon:pause', paused: true });
  raf();
  raf();
  assert.equal(frames.length, 1, 'paused: held back');
  s.send({ type: 'xrb-icon:capture', id: 1 });
  assert.deepEqual(ran, ['render'], 'capture draws its own frame while paused');
  assert.equal(s.sent.at(-1).message.type, 'xrb-icon:png');
  s.send({ type: 'xrb-icon:pause', paused: false });
  assert.equal(frames.length, 3, 'resume: the held frames are requested again');
  stop();
  raf();
  assert.equal(frames.length, 4);
});
test("one server per page: a later one (the app's own) replaces the earlier one", () => {
  const a = studio();
  const b = studio();
  const canvas = { toBlob: (cb: (b: Blob | null) => void) => cb(new Blob(['x'])) };
  const stopA = serveIconCapture(canvas, () => {}, 512, a.env);
  assert.equal(iconServing(), true);
  const stopB = serveIconCapture(canvas, () => {}, 512, b.env);
  assert.equal(a.listening(), false, 'the earlier server stopped');
  assert.equal(b.listening(), true);
  stopA();
  assert.equal(iconServing(), true, 'stopping the replaced one changes nothing');
  stopB();
  assert.equal(iconServing(), false);
});

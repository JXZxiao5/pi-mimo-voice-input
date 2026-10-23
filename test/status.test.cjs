const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createJiti } = require('jiti');

const { VoiceStatusBar } = createJiti(__filename)('../src/status.ts');

function setup(t, options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 });
  const statuses = [];
  const colors = [];
  const ctx = {
    hasUI: true, mode: 'tui', ...options,
    ui: {
      theme: { fg: (color, text) => { colors.push({ color, text }); return text; } },
      setStatus: (key, text) => { assert.equal(key, 'mimo-voice'); statuses.push(text); },
    },
  };
  const bar = new VoiceStatusBar();
  t.after(() => bar.stop());
  return { bar, ctx, statuses, colors, get text() { return statuses.at(-1); } };
}

test('idle and disabled states are dim, compact, and respect the configured shortcut', t => {
  const app = setup(t);
  app.bar.update(app.ctx, { kind: 'idle', enabled: true, shortcut: 'f8' });
  assert.equal(app.text, '○ 语音 · F8');
  assert.deepEqual(app.colors.at(-1), { color: 'dim', text: app.text });
  t.mock.timers.tick(1000);
  assert.equal(app.statuses.length, 1, 'an unchanged status never triggers another UI write');
  app.bar.update(app.ctx, { kind: 'idle', enabled: true, shortcut: 'ctrl+shift+v' });
  assert.equal(app.text, '○ 语音 · ctrl+shift+v');
  app.bar.update(app.ctx, { kind: 'idle', enabled: false, shortcut: 'f8' });
  assert.equal(app.text, '○ 语音已关闭');
});

test('recording counts from readiness, uses only a red dot, and shows how to stop', t => {
  const app = setup(t);
  app.bar.update(app.ctx, { kind: 'starting' });
  t.mock.timers.tick(4000);
  app.colors.length = 0;
  app.bar.update(app.ctx, { kind: 'recording', startedAt: Date.now(), test: false, shortcut: 'f12' });
  assert.equal(app.text, '● 录音 00:00 · F12 停止');
  assert.deepEqual(app.colors, [
    { color: 'error', text: '●' }, { color: 'dim', text: ' · F12 停止' },
  ]);
  t.mock.timers.tick(1000);
  assert.equal(app.text, '● 录音 00:01 · F12 停止');
  t.mock.timers.tick(64000);
  assert.equal(app.text, '● 录音 01:05 · F12 停止');
  app.bar.update(app.ctx, { kind: 'recording', startedAt: Date.now(), test: true, shortcut: 'f8' });
  assert.equal(app.text, '● 自检录音 00:00 · /voice-test 停止');
});

test('startup, recognition and cleanup share a lightweight themed spinner', t => {
  const app = setup(t);
  for (const [kind, label] of [['starting', '麦克风启动中'], ['recognizing', '识别中'], ['cleaning', '整理中']]) {
    app.bar.update(app.ctx, { kind });
    assert.equal(app.text, `◜ ${label}`);
    assert.deepEqual(app.colors.at(-1), { color: 'accent', text: '◜' });
    t.mock.timers.tick(120);
    assert.equal(app.text, `◝ ${label}`);
    t.mock.timers.tick(120);
    assert.equal(app.text, `◞ ${label}`);
  }
  app.bar.update(app.ctx, { kind: 'replaying' });
  assert.equal(app.text, '▷ 自检回放 · /voice-test 停止');
  const count = app.statuses.length;
  t.mock.timers.tick(1000);
  assert.equal(app.statuses.length, count, 'switching states cancels the old spinner');
});

test('theme changes repaint even an idle status without caching stale ANSI colors', t => {
  const app = setup(t);
  app.ctx.ui.theme = { fg: (color, text) => `<dark:${color}>${text}</>` };
  app.bar.update(app.ctx, { kind: 'idle', enabled: true, shortcut: 'f8' });
  assert.equal(app.text, '<dark:dim>○ 语音 · F8</>');
  app.ctx.ui.theme = { fg: (color, text) => `<light:${color}>${text}</>` };
  t.mock.timers.tick(1000);
  assert.equal(app.text, '<light:dim>○ 语音 · F8</>');
});

test('stop cancels refreshes and allows a fresh session with the same initial state', t => {
  const app = setup(t);
  app.bar.update(app.ctx, { kind: 'starting' });
  const count = app.statuses.length;
  app.bar.stop();
  app.bar.stop();
  t.mock.timers.tick(5000);
  assert.equal(app.statuses.length, count, 'shutdown never leaves timers writing to an old context');
  app.bar.update(app.ctx, { kind: 'starting' });
  assert.equal(app.statuses.length, count + 1);
  assert.equal(app.text, '◜ 麦克风启动中');
  app.bar.stop();
  app.bar.update(app.ctx, { kind: 'recording', startedAt: Date.now(), test: false, shortcut: 'f8' });
  app.bar.stop();
  const recordingCount = app.statuses.length;
  t.mock.timers.tick(5000);
  assert.equal(app.statuses.length, recordingCount);
});

test('headless mode never writes UI and RPC does not start animation timers', t => {
  const app = setup(t, { hasUI: false });
  app.bar.update(app.ctx, { kind: 'starting' });
  t.mock.timers.tick(1000);
  assert.deepEqual(app.statuses, []);
  app.ctx.hasUI = true;
  app.ctx.mode = 'rpc';
  app.bar.update(app.ctx, { kind: 'starting' });
  assert.equal(app.text, '◜ 麦克风启动中');
  t.mock.timers.tick(1000);
  assert.equal(app.statuses.length, 1);
});

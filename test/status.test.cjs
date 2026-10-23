const { test } = require('node:test');
const assert = require('node:assert/strict');
const { stripVTControlCharacters } = require('node:util');
const { createJiti } = require('jiti');
const { VoiceStatusBar } = createJiti(__filename)('../src/status.ts');

// Test strings contain only ASCII, the existing one-column symbols and CJK labels.
const width = text => [...stripVTControlCharacters(text)].reduce((n, c) => n + (/\p{Script=Han}/u.test(c) ? 2 : 1), 0);
function setup(t, options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 });
  const statuses = [], colors = [];
  const ctx = { hasUI: true, mode: 'tui', ...options, ui: {
    theme: {
      fg: (color, text) => { colors.push({ color, text }); return text; },
    },
    setStatus: (_key, text) => statuses.push(text),
  } };
  const bar = new VoiceStatusBar();
  t.after(() => bar.stop());
  return { bar, ctx, statuses, colors, get text() { return stripVTControlCharacters(statuses.at(-1) ?? '').replace(/\u00a0/g, ' '); } };
}

test('idle, startup, recording and processing keep the same width and shortcut column', t => {
  const app = setup(t);
  for (const shortcut of ['f8', 'ctrl+shift+v']) {
    app.bar.update(app.ctx, { kind: 'idle', enabled: true, shortcut });
    const expectedWidth = width(app.text), keyColumn = width(app.text.split(' · ')[0]);
    const start = app.statuses.length;
    assert.equal(expectedWidth, shortcut === 'f8' ? 11 : 21);
    assert.equal(app.text, `○ 语音 · ${shortcut === 'f8' ? 'F8' : shortcut}`);
    app.bar.update(app.ctx, { kind: 'starting', shortcut });
    let previousPosition = 6;
    for (let i = 0; i < 20; i++) {
      const position = app.text.indexOf('○');
      assert.ok(position >= 0 && position <= previousPosition, 'dot only travels right to left');
      previousPosition = position;
      t.mock.timers.tick(50);
    }
    assert.ok(app.text.indexOf('○') > 0, 'elapsed time alone never signals readiness');
    app.bar.update(app.ctx, { kind: 'starting', progress: 1, shortcut });
    assert.equal(app.text.indexOf('○'), 0, 'last animation frame lands on recording dot');
    assert.equal(app.text.includes('●'), false);
    app.bar.update(app.ctx, { kind: 'recording', startedAt: Date.now(), test: false, shortcut });
    assert.equal(app.text.indexOf('●'), 0);
    t.mock.timers.tick(1000);
    assert.match(app.text, /0:01/);
    for (const kind of ['recognizing', 'cleaning']) app.bar.update(app.ctx, { kind });
    for (const text of app.statuses.slice(start)) {
      assert.equal(width(text), expectedWidth, text);
      assert.equal(width(stripVTControlCharacters(text).replace(/\u00a0/g, ' ').split(' · ')[0]), keyColumn, text);
      // Mirror Pi footer sanitation: ordinary padding would collapse and fail here.
      const rendered = text.replace(/[\r\n\t]/g, ' ').replace(/ +/g, ' ').trim();
      assert.equal(width(rendered), expectedWidth, 'footer must not collapse padding');
    }
  }
  assert.ok(app.colors.some(c => c.color === 'accent' && c.text === '○'));
  assert.ok(app.colors.some(c => c.color === 'error' && c.text === '●'));
  assert.ok(!app.colors.some(c => c.color === 'error' && c.text === '○'));
});

test('self-test startup, recording and playback share a stable layout', t => {
  const app = setup(t);
  app.bar.update(app.ctx, { kind: 'starting', test: true });
  const expected = width(app.text), keyColumn = width(app.text.split(' · ')[0]);
  app.bar.update(app.ctx, { kind: 'starting', test: true, progress: 1 });
  app.bar.update(app.ctx, { kind: 'recording', test: true, startedAt: Date.now(), shortcut: 'f8' });
  app.bar.update(app.ctx, { kind: 'replaying' });
  for (const text of app.statuses) {
    assert.equal(width(text), expected);
    assert.equal(width(stripVTControlCharacters(text).replace(/\u00a0/g, ' ').split(' · ')[0]), keyColumn);
    assert.match(text, /\/voice-test/);
  }
});

test('delayed devices never reach the left endpoint and repeated progress does not restart animation', t => {
  const app = setup(t);
  app.bar.update(app.ctx, { kind: 'starting' });
  t.mock.timers.tick(500);
  const position = app.text.indexOf('○');
  app.bar.update(app.ctx, { kind: 'starting', progress: 0.1 });
  assert.equal(app.text.indexOf('○'), position);
  t.mock.timers.tick(5000);
  assert.ok(app.text.indexOf('○') > 0);
  assert.match(app.text, /^ +○ +· F8$/);
  assert.ok(!app.colors.some(c => c.color === 'error'), 'warmup never uses the recording color');
  app.bar.stop();
  const count = app.statuses.length;
  t.mock.timers.tick(5000);
  assert.equal(app.statuses.length, count);
  app.bar.update(app.ctx, { kind: 'starting' });
  assert.equal(app.text.indexOf('○'), 5, 'fresh session resets the animation');
});

test('idle writes are deduplicated, theme changes repaint and disabled width is stable', t => {
  const app = setup(t);
  app.bar.update(app.ctx, { kind: 'idle', enabled: true, shortcut: 'f8' });
  const expected = width(app.text);
  t.mock.timers.tick(1000);
  assert.equal(app.statuses.length, 1);
  app.bar.update(app.ctx, { kind: 'idle', enabled: false, shortcut: 'f8' });
  assert.equal(width(app.text), expected);
  app.ctx.ui.theme.fg = (_color, text) => `\x1b[31m${text}\x1b[0m`;
  t.mock.timers.tick(1000);
  assert.ok(app.statuses.at(-1).includes('\x1b[31m'));
  assert.equal(width(app.text), expected);
});

test('headless mode does not write and RPC does not animate; old themes degrade gracefully', t => {
  const app = setup(t, { hasUI: false });
  app.bar.update(app.ctx, { kind: 'starting' });
  t.mock.timers.tick(1000);
  assert.deepEqual(app.statuses, []);
  app.ctx.hasUI = true;
  app.ctx.mode = 'rpc';
  app.ctx.ui.theme = { fg: (_color, text) => text };
  app.bar.update(app.ctx, { kind: 'starting' });
  t.mock.timers.tick(1000);
  assert.equal(app.statuses.length, 1);
});

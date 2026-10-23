const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { tmpdir } = require('node:os');
const { basename, join } = require('node:path');
const { createJiti } = require('jiti');
const { wav, executable, waitFor } = require('./support/helpers.cjs');

async function setup(t, recorderFails = false, sample = wav(), config = {}, vadOptions = {}, recorderOptions = {}) {
  // Fake recorder includes the same 1000ms startup segment as a real stream.
  sample = Buffer.concat([sample.subarray(0, 44), Buffer.alloc(32000), sample.subarray(44)]);
  sample.writeUInt32LE(sample.length - 8, 4);
  sample.writeUInt32LE(sample.length - 44, 40);
  const home = fs.mkdtempSync(join(tmpdir(), 'mimo-extension-test-'));
  const bin = join(home, 'bin');
  fs.mkdirSync(bin);
  fs.mkdirSync(join(home, '.pi'));
  // Detect accidental CLI fallback without depending on the discarded Codex service.
  executable(join(bin, 'codex'), `
    require('node:fs').writeFileSync(${JSON.stringify(join(home, 'codex-pid'))}, String(process.pid));
    process.exit(1);
  `);
  fs.writeFileSync(join(home, 'vad-options.json'), JSON.stringify(vadOptions));
  fs.writeFileSync(join(home, 'recorder-options.json'), JSON.stringify(recorderOptions));
  fs.writeFileSync(join(home, '.pi/mimo-voice-zh.json'), JSON.stringify({
    apiKey: 'fake-api-key', sttEnabled: true, ...config,
  }));
  const originalPath = process.env.PATH;
  const originalHome = process.env.HOME;
  process.env.HOME = home;
  process.env.PATH = bin;
  const calls = new Map();
  const events = new Map();
  const notices = [];
  const statuses = [];
  let editor = '已有草稿';
  let status = '';
  let recordingPath;
  executable(join(bin, 'parecord'), recorderFails
    ? `process.stderr.write('麦克风连接失败'); process.exit(1);`
    : `
      const fs = require('node:fs');
      const path = process.argv.at(-1);
      process.on('SIGINT', () => setTimeout(() => {
        fs.writeFileSync(path, Buffer.from('${sample.toString('base64')}', 'base64'));
        process.exit(0);
      }, 150));
      const sample = Buffer.from('${sample.toString('base64')}', 'base64');
      const header = Buffer.from(sample.subarray(0, 44));
      header.writeUInt32LE(0xffffffff, 4);
      header.writeUInt32LE(0xffffffff, 40);
      fs.writeFileSync(path, header);
      fs.writeFileSync('${join(home, 'recording-path')}', path);
      fs.writeFileSync('${join(home, 'recorder-pid')}', String(process.pid));
      fs.writeFileSync('${join(home, 'recorder-args')}', JSON.stringify(process.argv.slice(2)));
      const options = JSON.parse(fs.readFileSync('${join(home, 'recorder-options.json')}', 'utf8'));
      if (!options.manualAudio) setTimeout(() => fs.appendFileSync(path, sample.subarray(44)), 0);
      setInterval(() => {}, 1000);
    `);
  executable(join(bin, 'paplay'), `
    const fs = require('node:fs');
    if (fs.readFileSync(process.argv[2]).toString('ascii', 0, 4) !== 'RIFF') process.exit(1);
    fs.writeFileSync('${join(home, 'played')}', 'ok');
  `);
  const factory = createJiti(__filename, {
    moduleCache: false,
    alias: { 'onnxruntime-web': join(__dirname, 'support/fake-ort.cjs') },
  })('../index.ts').default;
  const ctx = {
    hasUI: true, mode: 'tui',
    ui: {
      theme: { fg: (_color, text) => text },
      notify: (text, level) => notices.push({ text, level }),
      setStatus: (_key, value) => {
        // Match visible text while retaining all layout spaces for lifecycle assertions.
        value = require('node:util').stripVTControlCharacters(value).replace(/\u00a0/g, ' ');
        status = value; statuses.push(value);
      },
      getEditorText: () => editor,
      setEditorText: value => { editor = value; },
    },
  };
  factory({
    on: (name, callback) => events.set(name, callback),
    registerShortcut: (name, value) => calls.set(name, () => value.handler(ctx)),
    registerCommand: (name, value) => calls.set(name, () => value.handler('', ctx)),
  });
  t.after(async () => {
    await events.get('session_shutdown')({}, ctx);
    process.env.PATH = originalPath;
    process.env.HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
  });
  await events.get('session_start')({}, ctx);
  return {
    ctx, notices, statuses, calls, events, home,
    // Lifecycle assertions ignore padding; status.test.cjs checks raw terminal columns.
    get status() { return status.replace(/ {2,}/g, ' ').trimEnd(); },
    get editor() { return editor; },
    async ready() {
      await waitFor(() => fs.existsSync(join(home, 'recording-path'))
        && fs.existsSync(fs.readFileSync(join(home, 'recording-path'), 'utf8')));
      recordingPath = fs.readFileSync(join(home, 'recording-path'), 'utf8');
      return recordingPath;
    },
    get played() { return fs.existsSync(join(home, 'played')); },
  };
}

test('new user configuration and diagnostics only expose MiMo', async t => {
  const app = await setup(t);
  await app.events.get('session_shutdown')({}, app.ctx);
  const configPath = join(app.home, '.pi/mimo-voice-zh.json');
  fs.unlinkSync(configPath);
  await app.events.get('session_start')({}, app.ctx);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(config.cleanupModel, 'mimo-v2.6-flash');
  assert.equal(Object.hasOwn(config, 'deepseekApiKey'), false);
  await app.calls.get('voice-status')();
  assert.ok(!/deepseek/i.test(app.notices.at(-1).text));
});

test('explicit private cleanup configuration remains usable without changing MiMo ASR', async t => {
  const app = await setup(t, false, wav(), {
    textCleanupEnabled: true, cleanupModel: 'deepseek-flash', deepseekApiKey: 'private-test-key',
  });
  const models = [];
  t.mock.method(global, 'fetch', async (url, opts) => {
    const body = JSON.parse(opts.body);
    models.push(body.model);
    if (body.model === 'mimo-v2.5-asr') {
      assert.equal(opts.headers['api-key'], 'fake-api-key');
      return Response.json({ choices: [{ message: { content: '嗯检查日志' } }] });
    }
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    assert.equal(opts.headers.Authorization, 'Bearer private-test-key');
    return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '检查日志。' } }] });
  });
  await app.calls.get('voice')();
  await app.ready();
  await app.calls.get('voice')();
  assert.deepEqual(models, ['mimo-v2.5-asr', 'deepseek-flash']);
  assert.equal(app.editor, '已有草稿\n检查日志。');
});

function mockVoiceAPI(t, raw, cleaned = raw, options = {}) {
  const cleanupCalls = [];
  const fetch = t.mock.method(global, 'fetch', async (_url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.model === 'mimo-v2.5-asr') return Response.json({ choices: [{ message: { content: raw } }] });
    cleanupCalls.push({ body, signal: opts.signal });
    if (options.hang) await new Promise((_, reject) => {
      if (opts.signal.aborted) reject(opts.signal.reason);
      else opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true });
    });
    if (options.delayMs) await new Promise(resolve => setTimeout(resolve, options.delayMs));
    if (options.status) return Response.json({ error: { message: 'SECRET_AUTH fake-api-key PRIVATE_TRANSCRIPT' } }, { status: options.status });
    return Response.json({ choices: [{ finish_reason: options.finishReason ?? 'stop', message: { role: 'assistant',
      content: cleaned, tool_calls: options.toolCalls } }] });
  });
  return { fetch, cleanupCalls };
}

function installWebrtcPulse(app, loadDelay = 0, fail = false) {
  const log = join(app.home, 'pulse-calls');
  executable(join(app.home, 'bin/pactl'), `
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    fs.appendFileSync('${log}', JSON.stringify(args) + '\\n');
    if (args[0] === 'info') process.stdout.write('Default Source: input.mic\\nDefault Sink: output.speakers\\n');
    else if (args[0] === 'list' && args[1] === 'sources') process.stdout.write('Source #7\\n  Name: input.mic\\n  Description: Test mic\\n  Mute: no\\n');
    else if (args[0] === 'load-module') {
      if (${fail}) { process.stderr.write('unsupported module'); process.exit(1); }
      setTimeout(() => process.stdout.write('35\\n'), ${loadDelay});
    }
  `);
  return () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(x => JSON.parse(x)) : [];
}

test('/voice waits for WAV finalization, preserves draft, blocks duplicate ASR, cleans files', async t => {
  const app = await setup(t);
  const fetch = t.mock.method(global, 'fetch', async (_url, opts) => {
    const body = JSON.parse(opts.body);
    const audio = body.messages[0].content[0].input_audio.data;
    assert.equal(audio, `data:audio/wav;base64,${wav().toString('base64')}`);
    return Response.json({ choices: [{ message: { content: '测试语音输入。' } }] });
  });
  await app.calls.get('voice')();
  assert.match(app.status, /^● 0:00 · F8$/);
  const path = await app.ready();
  assert.ok(basename(join(path, '..')).startsWith('pi-mimo-voice-input-'));
  const stopping = app.calls.get('voice')();
  await app.calls.get('voice')();
  assert.match(app.status, /识别/);
  assert.deepEqual(app.notices, []);
  assert.equal(fetch.mock.callCount(), 0);
  await stopping;
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(app.editor, '已有草稿\n测试语音输入。');
  assert.equal(fs.existsSync(path), false);
  assert.equal(app.status, '○ 语音 · F8');
  assert.deepEqual(app.notices, [], 'normal progress and transcription do not emit notifications');
  const dir = join(path, '..');
  await app.events.get('session_shutdown')({}, app.ctx);
  assert.equal(fs.existsSync(dir), false);
});

test('voice, F8, and self-test show startup until actual audio arrives and reject duplicate starts', async t => {
  for (const command of ['voice', 'f8', 'voice-test']) {
    await t.test(command, async t => {
      const app = await setup(t, false, wav(), {}, {}, { manualAudio: true });
      const fetch = t.mock.method(global, 'fetch', async () => { throw new Error('startup must not upload'); });
      const pending = app.calls.get(command)();
      assert.match(app.status, /^ +○ +· /);
      const path = await app.ready();
      assert.equal(fs.statSync(path).size, 44, 'recorder has only written an unfinished WAV header');
      assert.ok(!app.statuses.some(s => s.startsWith('●')));
      assert.deepEqual(app.notices, []);
      await app.calls.get(command)();
      assert.match(app.status, /^ +○ +· /);
      assert.deepEqual(app.notices, [], 'duplicate starts do not repeat progress as notifications');
      fs.appendFileSync(path, Buffer.alloc(31998)); // 999.9375ms is not ready.
      await new Promise(resolve => setTimeout(resolve, 80));
      assert.match(app.status, /^ +○ +· /);
      fs.appendFileSync(path, Buffer.alloc(2)); // Exactly 1000ms, even silence, is ready.
      await pending;
      assert.match(app.status, command === 'voice-test'
        ? /^● 0:00 · \/voice-test$/ : /^● 0:00 · F8$/);
      assert.deepEqual(app.notices, []);
      assert.equal(fetch.mock.callCount(), 0);
      await app.events.get('session_shutdown')({}, app.ctx);
      assert.equal(fs.existsSync(path), false);
    });
  }
});

test('startup timeout stops the recorder, unloads WebRTC, deletes audio, and allows retry', async t => {
  const app = await setup(t, false, wav(), { recordingProcessing: 'webrtc' }, {}, { manualAudio: true });
  const calls = installWebrtcPulse(app);
  const fetch = t.mock.method(global, 'fetch', async () => { throw new Error('timeout must not upload'); });
  const pending = app.calls.get('voice-test')();
  const path = await app.ready();
  const pid = Number(fs.readFileSync(join(app.home, 'recorder-pid'), 'utf8'));
  assert.match(app.status, /^ +○ +· /);
  await pending;
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.equal(fs.existsSync(path), false);
  assert.deepEqual(calls().filter(x => x[0] === 'unload-module'), [['unload-module', '35']]);
  assert.equal(app.notices.filter(n => n.level === 'error').length, 1);
  assert.ok(app.notices.some(n => /启动超时.*未收到音频数据/.test(n.text)));
  assert.ok(!app.notices.some(n => n.text.includes('可以说话了')));
  assert.ok(!app.statuses.some(s => s.startsWith('●')));
  assert.equal(app.status, '○ 语音 · F8');
  assert.equal(app.editor, '已有草稿');
  assert.equal(fetch.mock.callCount(), 0);
  fs.writeFileSync(join(app.home, 'recorder-options.json'), '{}');
  await app.calls.get('voice-test')();
  assert.match(app.status, /^● 0:00 · \/voice-test$/);
});

test('shutdown during startup cancels readiness without stale UI, cleans resources, and permits a new session', async t => {
  const app = await setup(t, false, wav(), { recordingProcessing: 'webrtc' }, {}, { manualAudio: true });
  const calls = installWebrtcPulse(app);
  const fetch = t.mock.method(global, 'fetch', async () => { throw new Error('shutdown must not upload'); });
  const pending = app.calls.get('voice-test')();
  const path = await app.ready();
  const pid = Number(fs.readFileSync(join(app.home, 'recorder-pid'), 'utf8'));
  const notices = app.notices.length;
  const statuses = app.statuses.length;
  await app.events.get('session_shutdown')({}, app.ctx);
  await pending;
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.equal(fs.existsSync(join(path, '..')), false);
  assert.equal(app.notices.length, notices);
  assert.equal(app.statuses.length, statuses);
  assert.deepEqual(calls().filter(x => x[0] === 'unload-module'), [['unload-module', '35']]);
  assert.equal(fetch.mock.callCount(), 0);
  fs.writeFileSync(join(app.home, 'recorder-options.json'), '{}');
  await app.events.get('session_start')({}, app.ctx);
  await app.calls.get('voice-test')();
  assert.match(app.status, /^● 0:00 · \/voice-test$/);
  assert.deepEqual(app.notices, []);
});

test('unexpected recorder exit after readiness still cleans state and reports exactly one error', async t => {
  const app = await setup(t);
  const fetch = t.mock.method(global, 'fetch', async () => { throw new Error('failed capture must not upload'); });
  await app.calls.get('voice')();
  const path = await app.ready();
  process.kill(Number(fs.readFileSync(join(app.home, 'recorder-pid'), 'utf8')), 'SIGTERM');
  await waitFor(() => app.notices.some(n => n.level === 'error'));
  assert.equal(app.notices.filter(n => n.level === 'error').length, 1);
  assert.equal(fs.existsSync(path), false);
  assert.equal(app.status, '○ 语音 · F8');
  assert.equal(fetch.mock.callCount(), 0);
  await app.calls.get('voice')();
  assert.match(app.status, /^● 0:00/);
});

test('default F8 shortcut toggles voice capture and recognizes into the editor', async t => {
  const app = await setup(t);
  assert.ok(app.calls.has('f8'));
  assert.ok(!app.calls.has('ctrl+shift+v'));
  assert.ok(!app.calls.has('f12'));
  const example = JSON.parse(fs.readFileSync(join(__dirname, '../examples/mimo-voice-input.example.json'), 'utf8'));
  assert.equal(example.sttShortcut, 'f8');
  const fetch = t.mock.method(global, 'fetch', async (_url, opts) => {
    assert.equal(JSON.parse(opts.body).model, 'mimo-v2.5-asr');
    return Response.json({ choices: [{ message: { content: 'F8 语音测试。' } }] });
  });
  await app.calls.get('f8')();
  await app.ready();
  assert.equal(app.status, '● 0:00 · F8');
  assert.deepEqual(app.notices, []);
  await app.calls.get('f8')();
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(app.editor, '已有草稿\nF8 语音测试。');
  assert.equal(app.status, '○ 语音 · F8');
  await app.calls.get('voice-status')();
  assert.match(app.notices.at(-1).text, /语音输入: \/voice 或 f8/);
});

test('custom shortcuts override F8 without rewriting existing preferences', async t => {
  for (const sttShortcut of ['alt+v', 'ctrl+shift+v', 'f12']) {
    await t.test(sttShortcut, async t => {
      const app = await setup(t, false, wav(), { sttShortcut });
      const configPath = join(app.home, '.pi/mimo-voice-zh.json');
      const before = fs.readFileSync(configPath, 'utf8');
      assert.deepEqual([...app.calls.keys()].sort(), [sttShortcut, 'voice', 'voice-raw', 'voice-status', 'voice-test']);
      await app.calls.get(sttShortcut)();
      const path = await app.ready();
      assert.equal(app.status, `● 0:00 · ${sttShortcut.replace(/f\d+/g, key => key.toUpperCase())}`);
      assert.deepEqual(app.notices, []);
      await app.calls.get('voice-status')();
      assert.ok(app.notices.at(-1).text.includes(`语音输入: /voice 或 ${sttShortcut}`));
      await app.events.get('session_shutdown')({}, app.ctx);
      assert.equal(fs.existsSync(path), false);
      assert.equal(fs.readFileSync(configPath, 'utf8'), before);
    });
  }
});

test('early nonzero recorder exit clears state and shows stderr without calling API', async t => {
  const app = await setup(t, true);
  const fetch = t.mock.method(global, 'fetch', async () => { throw new Error('should not upload'); });
  await app.calls.get('voice')();
  await waitFor(() => app.notices.some(n => n.text.includes('麦克风连接失败')));
  assert.equal(app.status, '○ 语音 · F8');
  assert.equal(fetch.mock.callCount(), 0);
  await app.calls.get('voice')();
  assert.equal(app.notices.filter(n => n.text.includes('麦克风连接失败')).length, 2);
  assert.equal(app.status, '○ 语音 · F8');
  assert.ok(!app.statuses.some(s => s.startsWith('●')));
  assert.ok(!app.notices.some(n => n.text.includes('可以说话了')));
});

test('shutdown stops recorder, deletes temp directory, and does not transcribe', async t => {
  const app = await setup(t);
  const fetch = t.mock.method(global, 'fetch', async () => { throw new Error('should not upload'); });
  await app.calls.get('voice')();
  const path = await app.ready();
  await app.events.get('session_shutdown')({}, app.ctx);
  assert.equal(fs.existsSync(join(path, '..')), false);
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(app.editor, '已有草稿');
});

test('shutdown aborts in-flight ASR without stale notifications or editor writes', async t => {
  const app = await setup(t);
  let requested = false;
  let aborted = false;
  t.mock.method(global, 'fetch', async (_url, opts) => new Promise((_resolve, reject) => {
    requested = true;
    opts.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
  }));
  await app.calls.get('voice')();
  await app.ready();
  const pending = app.calls.get('voice')();
  await waitFor(() => requested);
  const notices = app.notices.length;
  await app.events.get('session_shutdown')({}, app.ctx);
  await pending;
  assert.equal(aborted, true);
  assert.equal(app.notices.length, notices);
  assert.equal(app.editor, '已有草稿');
});

test('extension only registers speech-input commands and diagnostics never expose key', async t => {
  const app = await setup(t);
  const fetch = t.mock.method(global, 'fetch', async () => { throw new Error('diagnostics must not call API'); });
  assert.deepEqual([...app.calls.keys()].sort(), ['f8', 'voice', 'voice-raw', 'voice-status', 'voice-test']);
  assert.deepEqual([...app.events.keys()].sort(), ['session_shutdown', 'session_start']);
  await app.calls.get('voice-status')();
  const notice = app.notices.at(-1).text;
  assert.match(notice, /录音: parecord/);
  assert.match(notice, /自检回放: paplay/);
  assert.ok(!notice.includes('fake-api-key'));
  assert.equal(app.played, false);
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(app.status, '○ 语音 · F8');
});

test('/voice-test runs without key or STT, plays locally, never uploads or overwrites editor', async t => {
  const app = await setup(t, false, wav(), { apiKey: '', sttEnabled: false });
  assert.equal(app.status, '○ 关闭 · F8');
  const fetch = t.mock.method(global, 'fetch', async () => { throw new Error('must not upload self-test'); });
  await app.calls.get('voice-test')();
  const path = await app.ready();
  await app.calls.get('voice')();
  assert.ok(app.notices.some(n => n.text.includes('请用 /voice-test 停止')));
  await app.calls.get('voice-test')();
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(app.played, true);
  assert.equal(app.editor, '已有草稿');
  assert.equal(fs.existsSync(path), false);
  assert.equal(app.status, '○ 关闭 · F8');
  assert.ok(app.notices.some(n => n.text.includes('削波 0.0%')));
  await app.calls.get('voice-status')();
  assert.match(app.notices.at(-1).text, /最近录音检测: 录音 0.60s/);
});

test('silence and severely clipped input are rejected before ASR and not replayed', async t => {
  for (const [name, sample] of [['silence', wav(9600, 0)], ['clipped', wav(9600, 0, 32767)]]) {
    await t.test(name, async t => {
      const app = await setup(t, false, sample);
      const fetch = t.mock.method(global, 'fetch', async () => { throw new Error('must not upload damaged audio'); });
      await app.calls.get('voice')();
      const path = await app.ready();
      await app.calls.get('voice')();
      assert.equal(fetch.mock.callCount(), 0);
      assert.ok(app.notices.some(n => n.text.includes('未上传')));
      assert.equal(fs.existsSync(path), false);
      assert.equal(app.status, '○ 语音 · F8');
      await app.calls.get('voice-test')();
      await app.ready();
      await app.calls.get('voice-test')();
      assert.equal(app.played, false);
      assert.equal(fetch.mock.callCount(), 0);
    });
  }
});

test('muted microphone or system monitor are rejected before spawning the recorder', async t => {
  for (const [name, muted, monitor] of [['muted', true, false], ['monitor', false, true]]) {
    await t.test(name, async t => {
      const app = await setup(t);
      const source = monitor ? 'output.monitor' : 'input.mic';
      executable(join(app.home, 'bin/pactl'), `
        process.stdout.write(process.argv[2] === 'info'
          ? 'Default Source: ${source}\\n'
          : 'Source #7\\n  Name: ${source}\\n  Description: Test mic\\n  Mute: ${muted ? 'yes' : 'no'}\\n  Active Port: headset\\n');
      `);
      await app.calls.get('voice')();
      assert.equal(fs.existsSync(join(app.home, 'recording-path')), false);
      assert.ok(app.notices.some(n => n.level === 'error' && n.text.includes(monitor ? '回环' : '静音')));
    });
  }
});

test('WebRTC recording uses private processed source and unloads it before local replay', async t => {
  const app = await setup(t, false, wav(), { recordingProcessing: 'webrtc' });
  const calls = installWebrtcPulse(app);
  await app.calls.get('voice-test')();
  await app.ready();
  const args = JSON.parse(fs.readFileSync(join(app.home, 'recorder-args'), 'utf8'));
  assert.ok(args.some(x => x.startsWith('--device=pi_mimo_')));
  await app.calls.get('voice-test')();
  assert.equal(app.played, true);
  assert.equal(calls().filter(x => x[0] === 'load-module').length, 1);
  assert.deepEqual(calls().filter(x => x[0] === 'unload-module'), [['unload-module', '35']]);
  assert.ok(!calls().some(x => x[0].startsWith('set-')));
  assert.ok(app.notices.some(n => n.text.includes('WebRTC 降噪')));
});

test('shutdown cleans up an active WebRTC module and a late module initialization', async t => {
  await t.test('active recorder', async t => {
    const app = await setup(t, false, wav(), { recordingProcessing: 'webrtc' });
    const calls = installWebrtcPulse(app);
    await app.calls.get('voice-test')();
    await app.ready();
    await app.events.get('session_shutdown')({}, app.ctx);
    assert.deepEqual(calls().filter(x => x[0] === 'unload-module'), [['unload-module', '35']]);
  });
  await t.test('pending module load', async t => {
    const app = await setup(t, false, wav(), { recordingProcessing: 'webrtc' });
    const calls = installWebrtcPulse(app, 250);
    const pending = app.calls.get('voice-test')();
    await waitFor(() => calls().some(x => x[0] === 'load-module'));
    assert.match(app.status, /^ +○ +· /);
    assert.ok(!app.notices.some(n => n.text.includes('可以说话了')));
    const notices = app.notices.length;
    const statuses = app.statuses.length;
    await app.events.get('session_shutdown')({}, app.ctx);
    await pending;
    assert.equal(app.notices.length, notices);
    assert.equal(app.statuses.length, statuses);
    assert.equal(fs.existsSync(join(app.home, 'recording-path')), false);
    assert.deepEqual(calls().filter(x => x[0] === 'unload-module'), [['unload-module', '35']]);
  });
});

test('unsupported WebRTC module errors clearly without silently falling back to raw audio', async t => {
  const app = await setup(t, false, wav(), { recordingProcessing: 'webrtc' });
  const calls = installWebrtcPulse(app, 0, true);
  await app.calls.get('voice-test')();
  assert.equal(fs.existsSync(join(app.home, 'recording-path')), false);
  assert.ok(app.notices.some(n => n.text.includes('无法加载 PulseAudio WebRTC')));
  assert.ok(!calls().some(x => x[0].startsWith('set-')));
});

test('empty ASR response includes recording quality instead of asserting a mic cause', async t => {
  const app = await setup(t);
  t.mock.method(global, 'fetch', async () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: '' } }] }));
  await app.calls.get('voice')();
  await app.ready();
  await app.calls.get('voice')();
  const error = app.notices.find(n => n.level === 'error');
  assert.match(error.text, /空转写/);
  assert.match(error.text, /finish_reason=stop/);
  assert.match(error.text, /录音 0.60s/);
  assert.ok(!error.text.includes('fake-api-key'));
});

test('VAD rejects non-speech at normal levels without upload or editor changes', async t => {
  const app = await setup(t, false, wav(), {}, { probabilities: [] });
  const fetch = t.mock.method(global, 'fetch', async () => { throw new Error('must not upload non-speech'); });
  await app.calls.get('voice')();
  const path = await app.ready();
  await app.calls.get('voice')();
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(app.editor, '已有草稿');
  assert.ok(app.notices.some(n => n.text.includes('未检测到有效人声，未上传') && n.level === 'info'));
  assert.ok(!app.notices.some(n => n.level === 'error'));
  assert.equal(fs.existsSync(path), false);
  assert.deepEqual(fs.readdirSync(join(path, '..')), []);
  assert.ok(fs.existsSync(join(app.home, 'vad-released')));
  assert.equal(app.status, '○ 语音 · F8');
  await app.calls.get('voice-status')();
  assert.match(app.notices.at(-1).text, /Silero v5 本地检测/);
  assert.match(app.notices.at(-1).text, /未检测到有效人声/);
});

test('VAD uploads trimmed WAV with padding, short pauses, and all speech in one request', async t => {
  const sample = wav(16000 * 5);
  // Speech: 0.64–1.28s, pause 0.32s, speech 1.60–2.24s, then 1.28s pause, speech 3.52–4.16s.
  const probabilities = Array.from({ length: Math.ceil(16000 * 5 / 512) }, (_, i) =>
    (i >= 20 && i < 40) || (i >= 50 && i < 70) || (i >= 110 && i < 130) ? 0.9 : 0.01);
  const app = await setup(t, false, sample, {}, { probabilities });
  const fetch = t.mock.method(global, 'fetch', async (_url, opts) => {
    const encoded = JSON.parse(opts.body).messages[0].content[0].input_audio.data;
    const uploaded = Buffer.from(encoded.split(',')[1], 'base64');
    const first = sample.subarray(44 + (20 * 512 - 3200) * 2, 44 + (70 * 512 + 3200) * 2);
    const second = sample.subarray(44 + (110 * 512 - 3200) * 2, 44 + (130 * 512 + 3200) * 2);
    assert.equal(uploaded.readUInt32LE(4), uploaded.length - 8);
    assert.equal(uploaded.readUInt32LE(40), uploaded.length - 44);
    assert.deepEqual(uploaded.subarray(44), Buffer.concat([first, Buffer.alloc(3840), second]));
    return Response.json({ choices: [{ message: { content: '裁剪后识别。' } }] });
  });
  await app.calls.get('voice')();
  const path = await app.ready();
  await app.calls.get('voice')();
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(app.editor, '已有草稿\n裁剪后识别。');
  assert.deepEqual(fs.readdirSync(join(path, '..')), []);
  assert.deepEqual(app.notices, [], 'successful VAD details stay out of chat');
  await app.calls.get('voice-status')();
  assert.match(app.notices.at(-1).text, /VAD: 2 段人声.*裁去/);
});

test('a no-speech recording does not prevent the next voice input from recognizing', async t => {
  const app = await setup(t, false, wav(), {}, { probabilities: [] });
  const fetch = t.mock.method(global, 'fetch', async () =>
    Response.json({ choices: [{ message: { content: '下一段录音。' } }] }));
  await app.calls.get('voice')();
  await app.ready();
  await app.calls.get('voice')();
  assert.equal(fetch.mock.callCount(), 0);
  fs.writeFileSync(join(app.home, 'vad-options.json'), '{}');
  await app.calls.get('voice')();
  const path = await app.ready();
  await app.calls.get('voice')();
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(app.editor, '已有草稿\n下一段录音。');
  assert.deepEqual(fs.readdirSync(join(path, '..')), []);
  assert.equal(app.status, '○ 语音 · F8');
});

test('ASR failure removes both the original and VAD-trimmed audio', async t => {
  const app = await setup(t);
  const fetch = t.mock.method(global, 'fetch', async () => { throw new Error('mock network failure'); });
  await app.calls.get('voice')();
  const path = await app.ready();
  await app.calls.get('voice')();
  assert.equal(fetch.mock.callCount(), 1);
  assert.ok(app.notices.some(n => n.level === 'error' && n.text.includes('MiMo ASR 网络请求失败')));
  assert.deepEqual(fs.readdirSync(join(path, '..')), []);
  assert.equal(app.editor, '已有草稿');
  assert.equal(app.status, '○ 语音 · F8');
});

test('VAD can be disabled without loading the model; original WAV is uploaded', async t => {
  const sample = wav();
  const app = await setup(t, false, sample, { vadEnabled: false }, { failLoad: true });
  const fetch = t.mock.method(global, 'fetch', async (_url, opts) => {
    assert.equal(JSON.parse(opts.body).messages[0].content[0].input_audio.data,
      `data:audio/wav;base64,${sample.toString('base64')}`);
    return Response.json({ choices: [{ message: { content: '原始录音。' } }] });
  });
  await app.calls.get('voice')();
  await app.ready();
  await app.calls.get('voice')();
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(fs.existsSync(join(app.home, 'vad-created')), false);
  await app.calls.get('voice-status')();
  assert.match(app.notices.at(-1).text, /VAD: 已关闭/);
});

test('local self-test bypasses VAD and replays the untrimmed diagnostic recording', async t => {
  const app = await setup(t, false, wav(), {}, { failLoad: true });
  const fetch = t.mock.method(global, 'fetch', async () => { throw new Error('must not upload self-test'); });
  await app.calls.get('voice-test')();
  await app.ready();
  await app.calls.get('voice-test')();
  assert.equal(app.played, true);
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(fs.existsSync(join(app.home, 'vad-created')), false);
});

test('VAD load/inference failures and invalid probabilities fail closed and clean recordings', async t => {
  for (const vadOptions of [{ failLoad: true }, { failRun: true }, { invalidProbability: true }]) {
    await t.test(JSON.stringify(vadOptions), async t => {
      const app = await setup(t, false, wav(), {}, vadOptions);
      const fetch = t.mock.method(global, 'fetch', async () => { throw new Error('must not upload on VAD failure'); });
      await app.calls.get('voice')();
      const path = await app.ready();
      await app.calls.get('voice')();
      assert.equal(fetch.mock.callCount(), 0);
      assert.equal(app.editor, '已有草稿');
      assert.ok(app.notices.some(n => n.level === 'error' && n.text.includes('本地 VAD 失败，未上传')));
      assert.deepEqual(fs.readdirSync(join(path, '..')), []);
      assert.equal(app.status, '○ 语音 · F8');
      if (!vadOptions.failLoad) assert.ok(fs.existsSync(join(app.home, 'vad-released')));
    });
  }
});

test('shutdown cancels VAD initialization/inference and prevents uploads or stale UI writes', async t => {
  for (const [name, vadOptions, marker] of [
    ['initialization', { loadDelay: 250 }, 'vad-created'],
    ['inference', { runDelay: 250 }, 'vad-running'],
  ]) {
    await t.test(name, async t => {
      const app = await setup(t, false, wav(), {}, vadOptions);
      const fetch = t.mock.method(global, 'fetch', async () => { throw new Error('must not upload after shutdown'); });
      await app.calls.get('voice')();
      const path = await app.ready();
      const pending = app.calls.get('voice')();
      await waitFor(() => fs.existsSync(join(app.home, marker)));
      const notices = app.notices.length;
      await app.events.get('session_shutdown')({}, app.ctx);
      await pending;
      assert.equal(fetch.mock.callCount(), 0);
      assert.equal(app.notices.length, notices);
      assert.equal(app.editor, '已有草稿');
      assert.equal(fs.existsSync(join(path, '..')), false);
      assert.ok(fs.existsSync(join(app.home, 'vad-released')));
    });
  }
});

test('invalid VAD configuration is rejected before recording', async t => {
  for (const config of [{ vadEnabled: 'false' }, { vadThreshold: 0 }, { vadThreshold: 1 }, { vadThreshold: '0.5' }]) {
    await t.test(JSON.stringify(config), async t => {
      const app = await setup(t, false, wav(), config);
      await app.calls.get('voice')();
      assert.equal(fs.existsSync(join(app.home, 'recording-path')), false);
      assert.ok(app.notices.some(n => n.level === 'error' && /vadEnabled|vadThreshold/.test(n.text)));
    });
  }
});

test('custom VAD threshold is applied without overwriting existing configuration', async t => {
  const app = await setup(t, false, wav(), { vadThreshold: 0.8 }, { probabilities: Array(19).fill(0.7) });
  const configPath = join(app.home, '.pi/mimo-voice-zh.json');
  const original = fs.readFileSync(configPath, 'utf8');
  const fetch = t.mock.method(global, 'fetch', async () => { throw new Error('below threshold'); });
  await app.calls.get('voice')();
  await app.ready();
  await app.calls.get('voice')();
  assert.equal(fetch.mock.callCount(), 0);
  assert.ok(app.notices.some(n => n.text.includes('未检测到有效人声')));
  assert.equal(fs.readFileSync(configPath, 'utf8'), original);
});

test('MiMo cleans ASR text, preserves draft, and restores raw input without another request or Codex', async t => {
  const app = await setup(t, false, wav(), { textCleanupEnabled: true, codexProxy: 'ignored-invalid-proxy' });
  const { fetch, cleanupCalls } = mockVoiceAPI(t, '设置成五次，不对，八次，但不要超过十次。', '设置成八次，但不要超过十次。');
  await app.calls.get('voice')();
  await app.ready();
  assert.equal(fetch.mock.callCount(), 0, 'recording never prewarms or calls a model');
  await app.calls.get('voice')();
  assert.equal(app.editor, '已有草稿\n设置成八次，但不要超过十次。');
  assert.ok(app.statuses.some(s => s.includes(' 整理')));
  assert.deepEqual(app.notices, [], 'cleanup progress and result previews are status/editor-only');
  assert.equal(cleanupCalls.length, 1);
  assert.equal(cleanupCalls[0].body.model, 'mimo-v2.6-flash');
  assert.ok(!JSON.stringify(cleanupCalls[0].body).includes('已有草稿'));
  assert.equal(fs.existsSync(join(app.home, 'codex-pid')), false);
  await app.calls.get('voice-status')();
  assert.match(app.notices.at(-1).text, /MiMo API \/ mimo-v2.6-flash；思考已关闭；超时 5 秒/);
  assert.match(app.notices.at(-1).text, /已整理，待人工复核（[\d.]+ 秒）/);
  assert.match(app.notices.at(-1).text, /自然整理，允许改写，请复核/);
  assert.ok(!/设置成五次|fake-api-key|ignored-invalid-proxy/.test(app.notices.at(-1).text));
  await app.calls.get('voice-raw')();
  assert.equal(app.editor, '已有草稿\n设置成五次，不对，八次，但不要超过十次。');
  assert.equal(fetch.mock.callCount(), 2);
});

test('full-sentence rewrites are filled for human review and /voice-raw restores the exact original', async t => {
  const raw = '你能给我看一下，呃，你给的清洗的提示词，以及你你设置的什么规则呀？';
  const rewritten = '你能给我看一下清洗提示词，以及你设置了哪些规则吗？';
  const app = await setup(t, false, wav(), { textCleanupEnabled: true });
  const { fetch, cleanupCalls } = mockVoiceAPI(t, raw, rewritten);
  await app.calls.get('voice')();
  await app.calls.get('voice')();
  assert.equal(app.editor, '已有草稿\n' + rewritten);
  assert.deepEqual(cleanupCalls[0].body.response_format, { type: 'text' });
  assert.ok(!app.notices.some(n => n.level === 'warning' || n.level === 'error'));
  await app.calls.get('voice-status')();
  assert.match(app.notices.at(-1).text, /已整理，待人工复核/);
  assert.ok(!app.notices.at(-1).text.includes(raw));
  await app.calls.get('voice-raw')();
  assert.equal(app.editor, '已有草稿\n' + raw);
  assert.equal(fetch.mock.callCount(), 2);
});

test('unchanged model output is a successful no-op rather than a safety rejection', async t => {
  const app = await setup(t, false, wav(), { textCleanupEnabled: true });
  mockVoiceAPI(t, '检查一下。');
  await app.calls.get('voice')();
  await app.calls.get('voice')();
  assert.equal(app.editor, '已有草稿\n检查一下。');
  await app.calls.get('voice-status')();
  assert.match(app.notices.at(-1).text, /文本清洗: 无需调整/);
  await app.calls.get('voice-raw')();
  assert.match(app.notices.at(-1).text, /没有可恢复/);
});

test('typing during MiMo cleanup is preserved and duplicate commands do not issue more requests', async t => {
  const app = await setup(t, false, wav(), { textCleanupEnabled: true });
  const { fetch, cleanupCalls } = mockVoiceAPI(t, '呃，检查一下。', '检查一下。', { delayMs: 250 });
  await app.calls.get('voice')();
  await app.ready();
  const pending = app.calls.get('voice')();
  await waitFor(() => cleanupCalls.length === 1);
  app.ctx.ui.setEditorText('清洗期间的新草稿');
  await app.calls.get('voice')();
  assert.match(app.status, /整理/);
  assert.deepEqual(app.notices, []);
  await pending;
  assert.equal(fetch.mock.callCount(), 2);
  assert.equal(app.editor, '清洗期间的新草稿\n检查一下。');
  await app.calls.get('voice-raw')();
  assert.equal(app.editor, '清洗期间的新草稿\n呃，检查一下。');
});

test('restore never overwrites a changed draft, and reload forgets the raw transcript', async t => {
  const app = await setup(t, false, wav(), { textCleanupEnabled: true });
  mockVoiceAPI(t, '呃，检查一下。', '检查一下。');
  await app.calls.get('voice')();
  await app.ready();
  await app.calls.get('voice')();
  app.ctx.ui.setEditorText(app.editor + '用户的新内容');
  const changed = app.editor;
  await app.calls.get('voice-raw')();
  assert.equal(app.editor, changed);
  assert.match(app.notices.at(-1).text, /草稿已修改/);
  await app.events.get('session_start')({}, app.ctx);
  await app.calls.get('voice-raw')();
  assert.match(app.notices.at(-1).text, /没有可恢复/);
});

test('MiMo failure, timeout, bad config, empty text and incomplete responses fall back without recognition failure', async t => {
  for (const options of [
    { status: 401 }, { status: 429 }, { hang: true }, { invalidConfig: true },
    { text: '' }, { text: '   ' }, { text: '尚未完成', finishReason: 'length' },
    { toolCalls: [{ function: { name: 'shell' } }] },
  ]) {
    await t.test(JSON.stringify(options), async t => {
      const app = await setup(t, false, wav(), { textCleanupEnabled: true,
        cleanupTimeoutMs: options.invalidConfig ? 0 : 100 });
      const raw = '不要删除那个文件，最多 5 次。';
      const { fetch } = mockVoiceAPI(t, raw, options.text ?? raw, options);
      await app.calls.get('voice')();
      const path = await app.ready();
      await app.calls.get('voice')();
      assert.equal(app.editor, '已有草稿\n不要删除那个文件，最多 5 次。');
      assert.ok(app.notices.some(n => n.level === 'warning' && n.text.includes('保留原文')));
      assert.ok(!app.notices.some(n => n.level === 'error'));
      const reason = options.status ? new RegExp(`HTTP ${options.status}`)
        : options.hang ? /清洗超时/ : options.invalidConfig ? /清洗配置无效/ : /输出不完整、被拦截或含工具调用/;
      const warning = app.notices.find(n => n.level === 'warning' && n.text.startsWith('口语清洗未应用：'));
      assert.ok(warning);
      assert.match(warning.text, reason);
      assert.equal((warning.text.match(/保留原文/g) ?? []).length, 1);
      assert.ok(!app.notices.some(n => /SECRET_AUTH|fake-api-key|PRIVATE_TRANSCRIPT/.test(n.text)));
      assert.deepEqual(fs.readdirSync(join(path, '..')), []);
      assert.equal(app.status, '○ 语音 · F8');
      assert.equal(fetch.mock.callCount(), options.invalidConfig ? 1 : 2, 'no retry or Codex fallback');
      assert.equal(fs.existsSync(join(app.home, 'codex-pid')), false);
      await app.calls.get('voice-status')();
      assert.match(app.notices.at(-1).text, /已保留原文（[\d.]+ 秒）/);
      assert.match(app.notices.at(-1).text, reason);
      assert.ok(!app.notices.at(-1).text.includes('不要删除那个文件'));
    });
  }
});

test('shutdown cancels only its own cleanup without stale UI/editor writes or leftover service', async t => {
  const app = await setup(t, false, wav(), { textCleanupEnabled: true });
  const { cleanupCalls } = mockVoiceAPI(t, '呃，帮我查天气。', '帮我查天气。', { hang: true });
  await app.calls.get('voice')();
  const path = await app.ready();
  const pending = app.calls.get('voice')();
  await waitFor(() => cleanupCalls.length === 1);
  const notices = app.notices.length;
  await app.events.get('session_shutdown')({}, app.ctx);
  await pending;
  assert.equal(cleanupCalls[0].signal.aborted, true);
  assert.equal(app.notices.length, notices);
  assert.equal(app.editor, '已有草稿');
  assert.equal(fs.existsSync(join(app.home, 'codex-pid')), false);
  assert.equal(fs.existsSync(join(path, '..')), false);
});

test('disabled cleanup and self-test never issue text API calls or launch Codex', async t => {
  const app = await setup(t);
  const { fetch, cleanupCalls } = mockVoiceAPI(t, '呃，原始文字。');
  await app.calls.get('voice')();
  await app.ready();
  await app.calls.get('voice')();
  assert.equal(app.editor, '已有草稿\n呃，原始文字。');
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(cleanupCalls.length, 0);
  const configPath = join(app.home, '.pi/mimo-voice-zh.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  fs.writeFileSync(configPath, JSON.stringify({ ...config, textCleanupEnabled: true }));
  await app.events.get('session_start')({}, app.ctx);
  await app.calls.get('voice-test')();
  await app.ready();
  await app.calls.get('voice-test')();
  assert.equal(app.played, true);
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(fs.existsSync(join(app.home, 'codex-pid')), false);
});

test('enabled cleanup still skips text API after silence, no speech, or ASR failure', async t => {
  for (const mode of ['silence', 'no-speech', 'asr-failure']) {
    await t.test(mode, async t => {
      const app = await setup(t, false, mode === 'silence' ? wav(9600, 0) : wav(),
        { textCleanupEnabled: true }, mode === 'no-speech' ? { probabilities: Array(19).fill(0) } : {});
      const fetch = t.mock.method(global, 'fetch', async (_url, opts) => {
        assert.equal(JSON.parse(opts.body).model, 'mimo-v2.5-asr');
        return Response.json({ error: { message: 'ASR unavailable' } }, { status: 503 });
      });
      await app.calls.get('voice')();
      const path = await app.ready();
      await app.calls.get('voice')();
      assert.equal(fetch.mock.callCount(), mode === 'asr-failure' ? 1 : 0);
      assert.equal(app.editor, '已有草稿');
      assert.equal(fs.existsSync(path), false);
      assert.equal(fs.existsSync(join(app.home, 'codex-pid')), false);
    });
  }
});

test('custom MiMo model/timeout is applied without rewriting existing preferences', async t => {
  const app = await setup(t, false, wav(), { textCleanupEnabled: true, cleanupModel: 'mimo-v2.6-pro', cleanupTimeoutMs: 3000 });
  const configPath = join(app.home, '.pi/mimo-voice-zh.json');
  const original = fs.readFileSync(configPath, 'utf8');
  const { cleanupCalls } = mockVoiceAPI(t, '检查一下。');
  await app.calls.get('voice')();
  await app.calls.get('voice')();
  assert.equal(cleanupCalls[0].body.model, 'mimo-v2.6-pro');
  assert.equal(fs.readFileSync(configPath, 'utf8'), original);
  await app.calls.get('voice-status')();
  assert.match(app.notices.at(-1).text, /mimo-v2.6-pro；思考已关闭；超时 3 秒/);
});

test('local diagnostic replay can be stopped by /voice-test without any API call', async t => {
  const app = await setup(t);
  const fetch = t.mock.method(global, 'fetch', async () => { throw new Error('replay must not call API'); });
  executable(join(app.home, 'bin/paplay'), `
    const fs = require('node:fs');
    fs.writeFileSync('${join(app.home, 'played')}', 'ok');
    setInterval(() => {}, 1000);
  `);
  await app.calls.get('voice-test')();
  const path = await app.ready();
  const pending = app.calls.get('voice-test')();
  await waitFor(() => app.played && app.status.includes('回放'));
  assert.equal(app.status, '▷ 回放 · /voice-test');
  const notices = app.notices.length;
  await app.calls.get('voice-test')();
  await pending;
  assert.equal(app.notices.length, notices, 'stopping playback does not repeat status in chat');
  assert.equal(app.status, '○ 语音 · F8');
  assert.equal(fs.existsSync(path), false);
  assert.equal(fetch.mock.callCount(), 0);
});

test('shutdown stops local diagnostic replay and removes its recording', async t => {
  const app = await setup(t);
  executable(join(app.home, 'bin/paplay'), `
    const fs = require('node:fs');
    fs.writeFileSync('${join(app.home, 'played')}', 'ok');
    setInterval(() => {}, 1000);
  `);
  await app.calls.get('voice-test')();
  const path = await app.ready();
  const pending = app.calls.get('voice-test')();
  await waitFor(() => app.played);
  await app.events.get('session_shutdown')({}, app.ctx);
  await pending;
  assert.equal(fs.existsSync(join(path, '..')), false);
  assert.equal(app.editor, '已有草稿');
  assert.ok(!app.notices.some(n => n.level === 'error'));
});

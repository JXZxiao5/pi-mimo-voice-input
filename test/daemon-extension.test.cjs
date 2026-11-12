const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createServer } = require('node:net');
const { createJiti } = require('jiti');
const { wav, waitFor } = require('./support/helpers.cjs');

test('daemon extension starts immediately, uploads only returned WAV, preserves draft and disconnects on shutdown', { skip: process.platform !== 'linux' }, async t => {
  const home = fs.mkdtempSync(join(tmpdir(), 'mimo-daemon-ext-'));
  const env = { HOME: process.env.HOME, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR };
  process.env.HOME = home; process.env.XDG_RUNTIME_DIR = home;
  fs.mkdirSync(join(home, '.pi'));
  fs.mkdirSync(join(home, 'pi-mimo-voice'));
  fs.writeFileSync(join(home, '.pi/mimo-voice-zh.json'), JSON.stringify({
    apiKey: 'fake', recordingMode: 'daemon', vadEnabled: false,
  }));
  const requests = [];
  const sockets = new Set();
  const sample = wav();
  let owner;
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => { sockets.delete(socket); if (owner === socket) owner = undefined; });
    let buffer = '';
    socket.on('data', data => {
      buffer += data;
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const req = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1);
        requests.push(req);
        let result = {};
        if (req.op === 'start') owner = socket;
        if (req.op === 'cancel') owner = undefined;
        if (req.op === 'stop') { owner = undefined; result = { wav: sample.toString('base64') }; }
        if (req.op === 'status') result = { ready: true, busy: !!owner, owned: owner === socket, error: '' };
        socket.write(JSON.stringify({ id: req.id, result }) + '\n');
      }
    });
  });
  await new Promise(resolve => server.listen(join(home, 'pi-mimo-voice/capture.sock'), resolve));
  const events = new Map(), commands = new Map(), notices = [], statuses = new Map();
  let editor = '草稿';
  const ctx = { hasUI: true, mode: 'tui', ui: {
    theme: { fg: (_, text) => text }, setStatus: (k, v) => statuses.set(k, v),
    notify: message => notices.push(message), getEditorText: () => editor, setEditorText: text => { editor = text; },
  } };
  const factory = createJiti(__filename, { moduleCache: false })('../index.ts').default;
  factory({ on: (k, v) => events.set(k, v), registerCommand: (k, v) => commands.set(k, v.handler),
    registerShortcut: (k, v) => commands.set(k, (_, ctx) => v.handler(ctx)), });
  const originalFetch = global.fetch;
  const uploads = [];
  global.fetch = async (_url, options) => {
    uploads.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: '你好' } }] }), { status: 200 });
  };
  t.after(async () => {
    await events.get('session_shutdown')({}, ctx);
    global.fetch = originalFetch;
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(home, { recursive: true, force: true });
  });
  await events.get('session_start')({}, ctx);
  await waitFor(() => requests.some(r => r.op === 'status'));
  const start = performance.now();
  await commands.get('f8')('', ctx);
  assert.ok(performance.now() - start < 500, 'no per-utterance one-second warmup');
  assert.equal(requests.filter(r => r.op === 'start').length, 1);
  await commands.get('f8')('', ctx);
  assert.equal(uploads.length, 1, notices.join('\n'));
  assert.equal(editor, '草稿\n你好');
  assert.ok(JSON.stringify(uploads[0]).includes(sample.toString('base64')), 'WAV not warmup-trimmed');
  await commands.get('f8')('', ctx);
  await events.get('session_shutdown')({}, ctx);
  await waitFor(() => sockets.size === 0);
  assert.equal(uploads.length, 1, 'unfinished recording never uploaded');
  assert.equal(statuses.get('mimo-capture'), undefined);
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createServer } = require('node:net');
const fs = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { createJiti } = require('jiti');
const { CaptureClient, captureTime } = createJiti(__filename)('../src/daemon.ts');
const config = { recordingDevice: '', recordingProcessing: 'none', recordingBackend: 'auto' };

test('broker buffer, timestamps, ownership, cancellation and compatibility', { skip: process.platform !== 'linux' }, () => {
  execFileSync('/usr/bin/python3', ['-B', join(__dirname, 'daemon_test.py')], { stdio: 'pipe' });
});

test('client protocol handles status, WAV, errors, config and disconnect without launching a service', { skip: process.platform !== 'linux' }, async t => {
  const runtime = fs.mkdtempSync(join(tmpdir(), 'mimo-daemon-'));
  fs.mkdirSync(join(runtime, 'pi-mimo-voice'));
  const old = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = runtime;
  const sockets = new Set();
  const requests = [];
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    socket.on('data', data => {
      buffer += data;
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const req = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1);
        requests.push(req);
        if (req.op === 'hang') { socket.destroy(); return; }
        const reply = req.op === 'bad' ? { error: 'busy' } : { result: req.op === 'stop'
          ? { wav: Buffer.from('audio').toString('base64') }
          : { ready: true, busy: false, owned: false, error: '' } };
        const line = JSON.stringify({ id: req.id, ...reply }) + '\n';
        // Exercise fragmented replies.
        socket.write(line.slice(0, 3)); socket.write(line.slice(3));
      }
    });
  });
  await new Promise(resolve => server.listen(join(runtime, 'pi-mimo-voice/capture.sock'), resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    if (old === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = old;
    fs.rmSync(runtime, { recursive: true, force: true });
  });
  const client = await CaptureClient.open(config, false);
  assert.equal(requests[0].config.recordingWarmupMs, 1000);
  assert.equal((await client.status()).ready, true);
  const at = captureTime();
  await client.start(at);
  assert.equal(requests.at(-1).at, at);
  assert.equal((await client.stop(captureTime())).toString(), 'audio');
  await assert.rejects(client.request('bad'), /busy/);
  await assert.rejects(client.request('hang'), /断开/);
  await assert.rejects(client.status(), /未连接/);
});

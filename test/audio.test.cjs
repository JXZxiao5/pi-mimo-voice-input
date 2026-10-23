const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { getEventListeners } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createJiti } = require('jiti');
const { wav, executable, waitFor } = require('./support/helpers.cjs');
const audio = createJiti(__filename)('../src/audio.ts');
const has = (...names) => name => names.includes(name);

test('Linux prefers PulseAudio and emits 16 kHz mono WAV with short latency', () => {
  const spec = audio.recordingCommand('/tmp/speech.wav', 'auto', 'my-mic', 'linux', has('parecord', 'arecord'));
  assert.equal(spec.command, 'parecord');
  for (const flag of ['--file-format=wav', '--format=s16le', '--rate=16000', '--channels=1', '--latency-msec=50', '--device=my-mic']) {
    assert.ok(spec.args.includes(flag));
  }
  assert.equal(spec.args.at(-1), '/tmp/speech.wav');
});

test('ALSA fallback, explicit device/backend, macOS compatibility, missing tools', () => {
  const spec = audio.recordingCommand('x.wav', 'auto', '', 'linux', has('arecord'));
  assert.equal(spec.command, 'arecord');
  assert.deepEqual(spec.args.slice(0, 3), ['-q', '-D', 'default']);
  assert.ok(audio.recordingCommand('x.wav', 'arecord', 'plughw:0,0', 'linux', has('parecord', 'arecord')).args.includes('plughw:0,0'));
  assert.equal(audio.recordingCommand('x.wav', 'auto', '', 'darwin', has('sox')).command, 'sox');
  assert.throws(() => audio.recordingCommand('x', 'auto', '', 'linux', has()), /apt install/);
  assert.throws(() => audio.recordingCommand('x', 'auto', '', 'win32', has('sox')), /暂不支持/);
  assert.throws(() => audio.recordingCommand('x', 'bogus', '', 'linux', has('sox')), /不支持录音后端/);
});

test('Linux playback fallback and macOS afplay', () => {
  assert.equal(audio.playbackCommand('x.wav', 'linux', has('paplay', 'aplay')).command, 'paplay');
  assert.deepEqual(audio.playbackCommand('x.wav', 'linux', has('aplay')).args, ['-q', 'x.wav']);
  assert.ok(audio.playbackCommand('x.wav', 'linux', has('ffplay')).args.includes('-nodisp'));
  assert.equal(audio.playbackCommand('x.wav', 'darwin', has('afplay')).command, 'afplay');
  assert.throws(() => audio.playbackCommand('x.wav', 'linux', has()), /apt install/);
});

test('WAV validation rejects empty, unfinished, invalid, and oversized recordings', t => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'mimo-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'sample.wav');
  fs.writeFileSync(path, wav());
  assert.equal(audio.wavBase64(path), wav().toString('base64'));
  fs.writeFileSync(path, wav(0));
  assert.throws(() => audio.wavBase64(path), /录音为空/);
  const incomplete = wav();
  incomplete.writeUInt32LE(0xffffffff, 40);
  fs.writeFileSync(path, incomplete);
  assert.throws(() => audio.wavBase64(path), /未写入完整/);
  fs.writeFileSync(path, Buffer.from('not a wav'));
  assert.throws(() => audio.wavBase64(path), /完整的 WAV/);
  fs.truncateSync(path, 7_500_001);
  assert.throws(() => audio.wavBase64(path), /10 MB/);
});

test('warmup trimming removes exactly 1000ms and keeps subsequent PCM unchanged', t => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'mimo-warmup-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'sample.wav');
  const speech = wav();
  const input = Buffer.concat([speech.subarray(0, 44), Buffer.alloc(32000, 0x7f), speech.subarray(44)]);
  input.writeUInt32LE(input.length - 8, 4);
  input.writeUInt32LE(input.length - 44, 40);
  fs.writeFileSync(path, input);
  audio.trimRecordingWarmup(path);
  assert.deepEqual(fs.readFileSync(path), speech);
  const onlyWarmup = input.subarray(0, 32044);
  onlyWarmup.writeUInt32LE(onlyWarmup.length - 8, 4);
  onlyWarmup.writeUInt32LE(32000, 40);
  fs.writeFileSync(path, onlyWarmup);
  assert.throws(() => audio.trimRecordingWarmup(path), /预热后录音为空/);
});

function idleRecorder(t) {
  const state = audio.startAudioProcess({
    command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'],
  });
  t.after(() => audio.stopAudioProcess(state, 'SIGTERM'));
  return state;
}

test('recording readiness requires a complete PCM frame, not headers, metadata, or speech', async t => {
  for (const metadata of [false, true]) {
    await t.test(metadata ? 'odd-sized metadata chunk' : 'standard header', async t => {
      const dir = fs.mkdtempSync(join(tmpdir(), 'mimo-test-'));
      t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
      const path = join(dir, 'sample.wav');
      const state = idleRecorder(t);
      const controller = new AbortController();
      const sample = wav(0);
      const junk = Buffer.alloc(12);
      junk.write('JUNK');
      junk.writeUInt32LE(3, 4);
      const header = metadata
        ? Buffer.concat([sample.subarray(0, 12), junk, sample.subarray(12)])
        : sample;
      // Live parecord/arecord/sox headers need not contain final RIFF/data lengths.
      header.writeUInt32LE(0xffffffff, 4);
      header.writeUInt32LE(0, header.length - 4);
      let ready = false;
      const pending = audio.waitForRecordingReady(state, path, controller.signal, 2000)
        .then(() => { ready = true; });
      await delay(40);
      assert.equal(ready, false, 'missing file is not ready');
      fs.writeFileSync(path, header);
      await delay(60);
      assert.equal(ready, false, 'headers/metadata alone are not audio');
      fs.appendFileSync(path, Buffer.alloc(1));
      await delay(60);
      assert.equal(ready, false, 'a partial 16-bit frame is not ready');
      fs.appendFileSync(path, Buffer.alloc(1));
      await pending;
      assert.equal(ready, true, 'silence is audio; no need to speak to trigger readiness');
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    });
  }
});

test('readiness rejects spawn failures and recorder exits before audio, including exit code zero', async t => {
  for (const [name, command, args, pattern] of [
    ['missing executable', join(tmpdir(), 'mimo-missing-recorder'), [], /ENOENT/],
    ['stderr', process.execPath, ['-e', "process.stderr.write('设备连接失败'); process.exit(1)"], /设备连接失败/],
    ['clean early exit', process.execPath, ['-e', 'process.exit(0)'], /开始采集前退出：0/],
  ]) {
    await t.test(name, async () => {
      const state = audio.startAudioProcess({ command, args });
      await assert.rejects(audio.waitForRecordingReady(state, 'unused.wav'), pattern);
      assert.equal(state.exited, true);
    });
  }
});

test('readiness times out without audio and releases cancellation listeners', async t => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'mimo-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'sample.wav');
  // A large RIFF with only metadata must not be mistaken for recorded audio.
  const metadata = Buffer.alloc(128);
  metadata.write('RIFF');
  metadata.write('WAVEJUNK', 8);
  metadata.writeUInt32LE(108, 16);
  fs.writeFileSync(path, metadata);
  const controller = new AbortController();
  await assert.rejects(audio.waitForRecordingReady(idleRecorder(t), path, controller.signal, 80), /启动超时.*未收到音频数据/);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('readiness cancellation is immediate, including an already-aborted signal', async t => {
  const state = idleRecorder(t);
  for (const alreadyAborted of [false, true]) {
    const controller = new AbortController();
    if (alreadyAborted) controller.abort();
    const pending = audio.waitForRecordingReady(state, 'unused.wav', controller.signal);
    if (!alreadyAborted) controller.abort();
    await assert.rejects(pending, /启动已取消/);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }
});

test('stop waits for close and delayed WAV finalization; spawn errors are observable', async t => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'mimo-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'sample.wav');
  const script = join(dir, 'record');
  executable(script, `
    const fs = require('node:fs');
    const path = process.argv[2];
    process.on('SIGINT', () => setTimeout(() => {
      fs.writeFileSync(path, Buffer.from('${wav().toString('base64')}', 'base64'));
      process.exit(0);
    }, 150));
    fs.writeFileSync(path, 'unfinished');
    setInterval(() => {}, 1000);
  `);
  const state = audio.startAudioProcess({ command: script, args: [path] });
  t.after(() => { if (!state.exited) state.child.kill('SIGKILL'); });
  await waitFor(() => fs.existsSync(path));
  const start = Date.now();
  assert.equal((await audio.stopAudioProcess(state)).code, 0);
  assert.ok(Date.now() - start >= 100);
  assert.equal(state.exited, true);
  assert.equal(audio.wavBase64(path), wav().toString('base64'));
  const missing = audio.startAudioProcess({ command: join(dir, 'missing'), args: [] });
  assert.equal((await missing.closed).error.code, 'ENOENT');
});

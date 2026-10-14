const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createJiti } = require('jiti');
const { wav, executable, waitFor } = require('./helpers.cjs');
const audio = createJiti(__filename)('../audio.ts');
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

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createJiti } = require('jiti');
const { wav } = require('./support/helpers.cjs');
const vad = createJiti(__filename)('../src/vad.ts');
const FRAME = 512;
const PAD = 3200;
const frames = (count, probability) => Array(count).fill(probability);

function workspace(t) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'mimo-vad-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { source: join(dir, 'source.wav'), destination: join(dir, 'speech.wav') };
}

test('VAD ignores silence and isolated spikes without counting silence/padding as speech', () => {
  assert.deepEqual(vad.speechSegments([], 0), []);
  assert.deepEqual(vad.speechSegments(frames(40, 0.01), 40 * FRAME), []);
  const spike = [...frames(5, 0.01), ...frames(2, 0.9), ...frames(40, 0.01)];
  assert.deepEqual(vad.speechSegments(spike, spike.length * FRAME), []);
});

test('short confirmations are preserved, trailing silence is trimmed even at EOF', () => {
  const scores = [...frames(4, 0.9), ...frames(20, 0.01)];
  assert.deepEqual(vad.speechSegments(scores, scores.length * FRAME), [{ start: 0, end: 4 * FRAME + PAD }]);
  const atEnd = [...frames(20, 0.01), ...frames(4, 0.9)];
  assert.deepEqual(vad.speechSegments(atEnd, atEnd.length * FRAME), [
    { start: 20 * FRAME - PAD, end: atEnd.length * FRAME },
  ]);
});

test('continuous speech and the final partial frame keep their exact original boundaries', () => {
  assert.deepEqual(vad.speechSegments(frames(19, 0.9), 9600), [{ start: 0, end: 9600 }]);
  // A zero-padded final frame must not artificially qualify a <128ms recording.
  assert.deepEqual(vad.speechSegments(frames(4, 0.9), FRAME * 3 + 100), []);
});

test('pauses shorter than 900ms are retained in a single segment', () => {
  const scores = [...frames(6, 0.9), ...frames(20, 0.01), ...frames(6, 0.9)];
  assert.deepEqual(vad.speechSegments(scores, scores.length * FRAME), [{ start: 0, end: scores.length * FRAME }]);
});

test('long pauses are split with 200ms edge padding, bounded by the original recording', () => {
  const scores = [...frames(20, 0.01), ...frames(20, 0.9), ...frames(32, 0.01), ...frames(20, 0.9), ...frames(20, 0.01)];
  assert.deepEqual(vad.speechSegments(scores, scores.length * FRAME), [
    { start: 20 * FRAME - PAD, end: 40 * FRAME + PAD },
    { start: 72 * FRAME - PAD, end: 92 * FRAME + PAD },
  ]);
});

test('hysteresis avoids cutting low-confidence word endings', () => {
  const scores = [...frames(4, 0.9), ...frames(20, 0.4), ...frames(40, 0.01)];
  assert.deepEqual(vad.speechSegments(scores, scores.length * FRAME), [{ start: 0, end: 24 * FRAME + PAD }]);
  assert.deepEqual(vad.speechSegments(frames(10, 0.7), 10 * FRAME, 0.8), []);
});

test('invalid thresholds, sample lengths, and probabilities fail closed', () => {
  for (const threshold of [0, 1, -1, NaN, Infinity, '0.5', null]) {
    assert.throws(() => vad.validateVadThreshold(threshold), /vadThreshold/);
  }
  for (const scores of [[NaN], [Infinity], [-0.1], [1.1], []]) {
    assert.throws(() => vad.speechSegments(scores, FRAME), /无效/);
  }
  assert.throws(() => vad.speechSegments([], -1), /无效/);
  assert.throws(() => vad.speechSegments([0.9], 0.5), /无效/);
});

test('cropping preserves PCM bytes, inserts a 120ms gap, and writes valid WAV lengths', () => {
  const original = wav(16000);
  const pcm = original.subarray(44);
  const result = vad.speechWav(pcm, [{ start: 1000, end: 5000 }, { start: 10000, end: 15000 }]);
  assert.deepEqual(result.subarray(44), Buffer.concat([
    pcm.subarray(2000, 10000), Buffer.alloc(3840), pcm.subarray(20000, 30000),
  ]));
  assert.equal(result.toString('ascii', 0, 4), 'RIFF');
  assert.equal(result.readUInt32LE(4), result.length - 8);
  assert.equal(result.readUInt32LE(40), result.length - 44);
  assert.deepEqual(result.subarray(8, 40), original.subarray(8, 40));
  assert.deepEqual(vad.speechWav(pcm, [{ start: 0, end: 16000 }]), original);
});

test('VAD rejects incompatible formats before loading the model', async t => {
  const { source, destination } = workspace(t);
  for (const [offset, value, bytes] of [[20, 3, 2], [22, 2, 2], [24, 8000, 4], [34, 8, 2]]) {
    const sample = wav();
    if (bytes === 2) sample.writeUInt16LE(value, offset);
    else sample.writeUInt32LE(value, offset);
    fs.writeFileSync(source, sample);
    await assert.rejects(vad.prepareSpeech(source, destination), /VAD 需要/);
    assert.equal(fs.existsSync(destination), false);
  }
});

test('pre-aborted VAD does not read audio, create a model, or write an output', async t => {
  const { source, destination } = workspace(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(vad.prepareSpeech(source, destination, 0.5, controller.signal), /abort/i);
  assert.equal(fs.existsSync(destination), false);
});

test('real bundled Silero CPU/WASM runs offline and rejects silence and a steady test tone', async t => {
  const { source, destination } = workspace(t);
  const fetch = t.mock.method(global, 'fetch', async () => { throw new Error('VAD must run offline'); });
  for (const amplitude of [0, 2000]) {
    const sample = wav(9600, amplitude);
    fs.writeFileSync(source, sample);
    const result = await vad.prepareSpeech(source, destination);
    assert.deepEqual(result.segments, []);
    assert.equal(result.originalDuration, 0.6);
    assert.equal(result.duration, 0);
    assert.equal(result.removedDuration, 0.6);
    assert.equal(fs.existsSync(destination), false);
    assert.deepEqual(fs.readFileSync(source), sample);
    assert.match(vad.speechSummary(result), /未检测到有效人声，未上传/);
  }
  assert.equal(fetch.mock.callCount(), 0);
});

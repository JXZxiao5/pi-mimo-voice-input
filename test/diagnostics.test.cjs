const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createJiti } = require('jiti');
const { wav } = require('./support/helpers.cjs');
const { inspectWav, audioIssues, qualitySummary, parsePulseInput, parseAlsaCapture } = createJiti(__filename)('../src/diagnostics.ts');

function inspect(t, data) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'mimo-diagnostics-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'sample.wav');
  fs.writeFileSync(path, data);
  return inspectWav(path);
}

test('valid speech-like PCM measures duration, AC RMS, peak, clipping, and DC', t => {
  const q = inspect(t, wav());
  assert.equal(q.duration, 0.6);
  assert.equal(q.sampleRate, 16000);
  assert.equal(q.channels, 1);
  assert.ok(Math.abs(q.acRmsDb - (-27.3)) < 0.2);
  assert.ok(Math.abs(q.peakDb - (-24.3)) < 0.2);
  assert.equal(q.clipRatio, 0);
  assert.ok(q.dcOffset < 0.0001);
  assert.deepEqual(audioIssues(q), []);
  assert.match(qualitySummary(q), /削波 0.0%/);
});

test('silence is blocked and quiet nonzero audio is warned, not treated as certain silence', t => {
  const silence = inspect(t, wav(9600, 0));
  assert.ok(audioIssues(silence).some(x => x.blocking && x.message.includes('静音')));
  assert.ok(!qualitySummary(silence).includes('NaN'));
  const quiet = inspect(t, wav(9600, 10));
  assert.ok(audioIssues(quiet).some(x => !x.blocking && x.message.includes('电平偏低')));
  assert.ok(!audioIssues(quiet).some(x => x.blocking));
});

test('clipped input, pathological DC, and short recording are detected separately', t => {
  const clipped = inspect(t, wav(9600, 0, 32767));
  assert.equal(clipped.clipRatio, 1);
  assert.ok(audioIssues(clipped).some(x => x.blocking && x.message.includes('削波')));
  const dc = inspect(t, wav(9600, 2000, 8000));
  assert.equal(dc.clipRatio, 0);
  assert.ok(audioIssues(dc).some(x => x.blocking && x.message.includes('直流')));
  const short = inspect(t, wav(1600));
  assert.ok(audioIssues(short).some(x => x.blocking && x.message.includes('0.25 秒')));
});

test('PCM metadata validation rejects non-PCM and mismatched frames', t => {
  const badFormat = wav();
  badFormat.writeUInt16LE(3, 20);
  assert.throws(() => inspect(t, badFormat), /16-bit PCM/);
  const badChannels = wav(9601);
  badChannels.writeUInt16LE(2, 22);
  assert.throws(() => inspect(t, badChannels), /16-bit PCM/);
});

test('opposite DC in stereo cannot cancel quality diagnostics', t => {
  const data = wav(19200, 0);
  data.writeUInt16LE(2, 22);
  data.writeUInt32LE(64000, 28);
  data.writeUInt16LE(4, 32);
  for (let i = 44; i < data.length; i += 4) {
    data.writeInt16LE(8000, i);
    data.writeInt16LE(-8000, i + 2);
  }
  const q = inspect(t, data);
  assert.equal(q.duration, 0.6);
  assert.equal(q.channels, 2);
  assert.ok(q.dcOffset > 0.2);
  assert.ok(audioIssues(q).some(x => x.blocking && x.message.includes('直流')));
});

const sources = `Source #6
  Name: output.monitor
  Description: System output monitor
  Mute: no
  Volume: front-left: 65536 / 100% / 0.00 dB
  Properties:
    device.class = "monitor"
Source #7
  Name: input.analog-stereo
  Description: Analog microphone
  Mute: yes
  Volume: front-left: 33925 / 52% / -17.16 dB
  Active Port: analog-input-headset-mic
  Properties:
    alsa.card = "0"
`;

test('PulseAudio diagnostics resolve real default input, port, mute, volume, and monitor', () => {
  const input = parsePulseInput('Default Source: input.analog-stereo\n', sources);
  assert.equal(input.name, 'input.analog-stereo');
  assert.equal(input.muted, true);
  assert.equal(input.port, 'analog-input-headset-mic');
  assert.equal(input.card, '0');
  assert.match(input.volume, /52%/);
  assert.equal(input.monitor, false);
  assert.equal(parsePulseInput('', sources, 'output.monitor').monitor, true);
  assert.equal(parsePulseInput('', sources, '7').name, input.name);
  assert.equal(parsePulseInput('', sources, 'missing'), undefined);
});

test('hardware gain diagnostics select the active mic boost, not another port', () => {
  const mixer = `Simple mixer control 'Capture',0
  Front Left: Capture 63 [100%] [30.00dB] [on]
  Front Right: Capture 63 [100%] [30.00dB] [on]
Simple mixer control 'Capture',1
  Front Left: Capture 0 [0%] [-17.25dB] [off]
Simple mixer control 'Headset Mic Boost',0
  Front Left: 1 [33%] [10.00dB]
Simple mixer control 'Headphone Mic Boost',0
  Front Left: 2 [67%] [20.00dB]
`;
  const gains = parseAlsaCapture(mixer, 'analog-input-headset-mic');
  assert.equal(gains.length, 2);
  assert.match(gains[0], /30.00dB/);
  assert.match(gains[1], /Headset Mic Boost.*10.00dB/);
  assert.ok(!gains.some(x => x.includes('20.00dB')));
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createJiti } = require('jiti');
const { prepareWebrtcInput } = createJiti(__filename)('../webrtc.ts');
const info = 'Default Source: input.mic\nDefault Sink: output.speakers\n';

function fakePulse() {
  const calls = [];
  const run = async args => {
    calls.push(args);
    if (args[0] === 'info') return info;
    if (args[0] === 'load-module') return '35\n';
    if (args[0] === 'unload-module') return '';
    throw new Error('Unexpected Pulse command');
  };
  return { calls, run };
}

test('WebRTC source is private, uses digital processing, and never changes system defaults/gain', async () => {
  const pulse = fakePulse();
  const input = await prepareWebrtcInput('', pulse.run, 'test_mic');
  assert.equal(input.source, 'test_mic');
  assert.equal(input.master, 'input.mic');
  assert.equal(input.moduleId, '35');
  const load = pulse.calls.find(x => x[0] === 'load-module');
  assert.ok(load.includes('source_master="input.mic"'));
  assert.ok(load.includes('sink_master="output.speakers"'));
  assert.ok(load.includes('source_name="test_mic"'));
  assert.ok(load.includes('aec_method=webrtc'));
  assert.ok(load.includes('use_volume_sharing=0'));
  const processing = load.find(x => x.startsWith('aec_args='));
  for (const flag of ['analog_gain_control=0', 'digital_gain_control=1', 'noise_suppression=1', 'high_pass_filter=1']) {
    assert.ok(processing.includes(flag));
  }
  await Promise.all([input.dispose(), input.dispose()]);
  await input.dispose();
  assert.deepEqual(pulse.calls.filter(x => x[0] === 'unload-module'), [['unload-module', '35']]);
  assert.ok(!pulse.calls.some(x => x[0].startsWith('set-')));
});

test('explicit input is quoted for module parsing without passing arguments through a shell', async () => {
  const pulse = fakePulse();
  await prepareWebrtcInput('custom"mic\\source', pulse.run, 'test_mic');
  assert.ok(pulse.calls.at(-1).includes('source_master="custom\\"mic\\\\source"'));
});

test('missing defaults and monitor sources fail before loading a module', async () => {
  const pulse = fakePulse();
  await assert.rejects(prepareWebrtcInput('output.monitor', pulse.run, 'test_mic'), /实际麦克风/);
  assert.ok(!pulse.calls.some(x => x[0] === 'load-module'));
  await assert.rejects(prepareWebrtcInput('', async () => '', 'test_mic'), /默认输入\/输出/);
});

test('failed/timed-out load cleans up only the module with this unique source name', async () => {
  const calls = [];
  const run = async args => {
    calls.push(args);
    if (args[0] === 'info') return info;
    if (args[0] === 'load-module') throw new Error('timed out');
    if (args[0] === 'list') return '34\tmodule-echo-cancel\tsource_name="test_mic_other"\n35\tmodule-echo-cancel\tsource_name="test_mic" sink_name="test_mic_sink"\n';
    if (args[0] === 'unload-module') return '';
    throw new Error('unexpected');
  };
  await assert.rejects(prepareWebrtcInput('', run, 'test_mic'), /无法加载/);
  assert.deepEqual(calls.filter(x => x[0] === 'unload-module'), [['unload-module', '35']]);
});

test('failed unload can be retried instead of marking a live module as disposed', async () => {
  let attempts = 0;
  const pulse = fakePulse();
  const run = async args => {
    if (args[0] === 'unload-module' && attempts++ === 0) throw new Error('temporary error');
    return pulse.run(args);
  };
  const input = await prepareWebrtcInput('', run, 'test_mic');
  await assert.rejects(input.dispose(), /temporary error/);
  await input.dispose();
  assert.equal(attempts, 2);
});

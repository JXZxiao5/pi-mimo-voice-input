const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createJiti } = require('jiti');
const { wav } = require('./support/helpers.cjs');
const api = createJiti(__filename)('../src/mimo.ts');

function sample(t) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'mimo-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'sample.wav');
  fs.writeFileSync(path, wav());
  return path;
}

test('ASR request matches official MiMo API schema and trims transcript', async t => {
  const path = sample(t);
  t.mock.method(global, 'fetch', async (url, opts) => {
    assert.equal(url, 'https://api.xiaomimimo.com/v1/chat/completions');
    assert.equal(opts.headers['api-key'], 'test-key');
    assert.equal(opts.method, 'POST');
    assert.equal(opts.redirect, 'error');
    const body = JSON.parse(opts.body);
    assert.equal(body.model, 'mimo-v2.5-asr');
    assert.deepEqual(body.asr_options, { language: 'zh' });
    assert.equal(body.messages[0].role, 'user');
    assert.deepEqual(body.messages[0].content[0], {
      type: 'input_audio', input_audio: { data: `data:audio/wav;base64,${wav().toString('base64')}` },
    });
    return Response.json({ choices: [{ message: { content: '  你好，Ubuntu。  ' } }] });
  });
  assert.equal(await api.callASR(path, 'test-key'), '你好，Ubuntu。');
});

test('ASR also accepts text content blocks without misreporting an empty transcript', async t => {
  const path = sample(t);
  t.mock.method(global, 'fetch', async () => Response.json({ choices: [{ message: { content: [
    { type: 'text', text: '测试' }, { type: 'text', text: '中文。' }, { type: 'audio', data: 'ignored' },
  ] } }] }));
  assert.equal(await api.callASR(path, 'test-key'), '测试中文。');
});

test('HTTP errors expose only status, never service bodies, keys, transcripts, or gateway details', async t => {
  const path = sample(t);
  for (const status of [400, 401, 403, 429, 500, 503]) {
    let cancelled = false;
    const fetch = t.mock.method(global, 'fetch', async () => ({
      ok: false, status,
      body: { cancel: async () => { cancelled = true; } },
      json: async () => { throw new Error('secret-key PRIVATE_TRANSCRIPT PRIVATE_GATEWAY'); },
    }));
    await assert.rejects(api.callASR(path, 'secret-key'), error => {
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert.ok(!/secret-key|PRIVATE_TRANSCRIPT|PRIVATE_GATEWAY/.test(error.message));
      return true;
    });
    assert.equal(cancelled, true);
    assert.equal(fetch.mock.callCount(), 1, 'HTTP failures do not retry');
    fetch.mock.restore();
  }
});

test('network and invalid JSON errors never expose raw exceptions', async t => {
  const path = sample(t);
  for (const phase of ['network', 'json']) {
    const fail = async () => { throw new Error('secret-key PRIVATE_TRANSCRIPT PRIVATE_GATEWAY'); };
    const fetch = t.mock.method(global, 'fetch', phase === 'network' ? fail : async () => ({ ok: true, json: fail }));
    await assert.rejects(api.callASR(path, 'secret-key'), error => {
      assert.match(error.message, phase === 'network' ? /网络请求失败/ : /不是有效 JSON/);
      assert.ok(!/secret-key|PRIVATE_TRANSCRIPT|PRIVATE_GATEWAY/.test(error.message));
      return true;
    });
    assert.equal(fetch.mock.callCount(), 1);
    fetch.mock.restore();
  }
});

test('empty transcript and empty recording are clear errors, no empty upload', async t => {
  const path = sample(t);
  const mock = t.mock.method(global, 'fetch', async () => Response.json({ choices: [{ message: { content: '' } }] }));
  await assert.rejects(api.callASR(path, 'test-key'), /未返回识别文字/);
  fs.writeFileSync(path, wav(0));
  await assert.rejects(api.callASR(path, 'test-key'), /录音为空/);
  assert.equal(mock.mock.callCount(), 1);
});

test('ASR-only API surface and caller cancellation', async t => {
  assert.deepEqual(Object.keys(api).sort(), ['ASR_MODEL', 'BASE_URL', 'callASR', 'errorMessage']);
  const path = sample(t);
  t.mock.method(global, 'fetch', async (_url, opts) => {
    assert.equal(JSON.parse(opts.body).model, 'mimo-v2.5-asr');
    if (opts.signal.aborted) throw new Error('request aborted');
    return Response.json({ choices: [{ message: { content: '你好' } }] });
  });
  assert.equal(await api.callASR(path, 'test-key'), '你好');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(api.callASR(path, 'test-key', controller.signal), /已取消/);
});

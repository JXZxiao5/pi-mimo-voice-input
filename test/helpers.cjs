const { writeFileSync } = require('node:fs');

function wav(samples = 9600, amplitude = 2000, dc = 0) {
  const data = Buffer.alloc(44 + samples * 2);
  data.write('RIFF');
  data.writeUInt32LE(data.length - 8, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(16000, 24);
  data.writeUInt32LE(32000, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    const sample = Math.max(-32768, Math.min(32767, Math.round(dc + amplitude * Math.sin(2 * Math.PI * 200 * i / 16000))));
    data.writeInt16LE(sample, 44 + i * 2);
  }
  return data;
}

function executable(path, code) {
  writeFileSync(path, `#!${process.execPath}\n${code}`, { mode: 0o755 });
}

async function waitFor(predicate, timeout = 5000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error('Timed out waiting for test condition');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

module.exports = { wav, executable, waitFor };

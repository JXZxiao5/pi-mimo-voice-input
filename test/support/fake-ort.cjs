// Integration tests stub model inference, not the VAD/cropping pipeline.
const fs = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');

class Tensor {
  constructor(type, data, dims) {
    this.type = type;
    this.data = data;
    this.dims = dims;
  }
  dispose() {}
}

module.exports = {
  env: { wasm: {} },
  Tensor,
  InferenceSession: {
    async create(_model, _options) {
      const home = homedir();
      const options = JSON.parse(fs.readFileSync(join(home, 'vad-options.json'), 'utf8'));
      fs.writeFileSync(join(home, 'vad-created'), 'ok');
      if (options.loadDelay) await new Promise(resolve => setTimeout(resolve, options.loadDelay));
      if (options.failLoad) throw new Error('mock model load failed');
      let frame = 0;
      return {
        async run({ input }) {
          fs.writeFileSync(join(home, 'vad-running'), 'ok');
          if (options.runDelay) await new Promise(resolve => setTimeout(resolve, options.runDelay));
          if (options.failRun) throw new Error('mock inference failed');
          const hasSignal = input.data.subarray(64).some(value => Math.abs(value) > 0.001);
          const probability = options.invalidProbability ? NaN
            : options.probabilities ? (options.probabilities[frame] ?? 0.01)
            : hasSignal ? 0.9 : 0.01;
          frame++;
          return {
            stateN: new Tensor('float32', new Float32Array(256), [2, 1, 128]),
            output: new Tensor('float32', Float32Array.from([probability]), [1, 1]),
          };
        },
        async release() {
          fs.writeFileSync(join(home, 'vad-released'), 'ok');
        },
      };
    },
  },
};

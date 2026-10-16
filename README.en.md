# pi-mimo-voice-input

[简体中文](README.md) | English

A Xiaomi MiMo-powered Chinese voice input extension for Pi on Ubuntu/Linux and macOS, with local voice activity detection, microphone diagnostics, and optional transcript cleanup.
Local Silero VAD is enabled by default; optional PulseAudio WebRTC recording processing is also available. This extension provides voice input only, not text-to-speech for AI replies.

## 1. Why MiMo?

- **Affordable for frequent, everyday use**: voice input typically means many short requests. MiMo's low model-call costs, combined with the small overhead of using Flash for short transcripts, make it a practical everyday input method.
- **Speech recognition and text models on one platform**: MiMo offers both speech recognition and Flash text models. A single regular API key covers the “record → transcribe → clean up” workflow, without integrating another model provider.
- **Flash is fast enough for direct transcript cleanup**: the default cleanup model, `mimo-v2.6-flash`, can handle filler words, repetition, punctuation, sentence breaks, and clear self-corrections directly. It is a good fit for cleaning up a transcript immediately after recognition, before inserting it into the editor draft.

Actual costs follow [MiMo's official pricing](https://mimo.mi.com/docs/zh-CN/price/pay-as-you-go); latency varies with network conditions, transcript length, and service load.
Cleanup is optional and disabled by default. Always review the result before sending.

## 2. Installation

Requires [Pi](https://github.com/earendil-works/pi) and Node.js ≥ 22.19. Install the recording tools for your platform first:

```bash
# Ubuntu / Debian
sudo apt install pulseaudio-utils alsa-utils
# macOS
brew install sox
```

Install from npm ([pi-mimo-voice-input@0.1.0](https://www.npmjs.com/package/pi-mimo-voice-input) is available):

```bash
pi install npm:pi-mimo-voice-input
```

Local installation / development:

```bash
git clone https://github.com/JXZxiao5/pi-mimo-voice-input.git
cd pi-mimo-voice-input
npm ci --ignore-scripts --legacy-peer-deps
pi install "$PWD"
```

Do not load both the local and npm versions at the same time. Before switching, run `pi remove <previous-install-source>` to remove the old package entry (the previous package was `npm:pi-mimo-voice-zh`).

## 3. Configuration

Get a regular API key from the [MiMo console](https://platform.xiaomimimo.com) (Token Plan keys are not supported).
Create or edit `~/.pi/mimo-voice-zh.json` (the original filename is retained for compatibility) and fill in `apiKey`:

```json
{
  "apiKey": "",
  "sttShortcut": "f8",
  "textCleanupEnabled": false
}
```

- `sttShortcut`: the recording shortcut; defaults to `f8`.
- `textCleanupEnabled`: optional transcript cleanup, disabled by default. Enabling it adds one MiMo text-model request; failures or timeouts keep the original transcript.
- Other settings use their defaults. See the [configuration example](examples/mimo-voice-input.example.json) for all options.

Protect your credentials with `chmod 600 ~/.pi/mimo-voice-zh.json`, then run `/reload` in Pi.
Never commit your actual configuration to Git.

## 4. Usage

- **`F8` or `/voice`**: start recording; use it again to stop and transcribe. Wait for the “可以说话了” (“You can speak now”) notification before speaking. Some keyboards require `Fn+F8`.
- **`/voice-test`**: run a local microphone check. Run it again to stop recording and play it back; recording is limited to 10 seconds. Run it during playback to stop playback.
- **`/voice-status`**: show the input device, recording diagnostics, and transcript cleanup status.
- **`/voice-raw`**: restore the original transcript from the latest cleanup. It will not overwrite a draft that has been edited or sent; the original is forgotten on exit or reload.
- **`/reload`**: reload the extension and its configuration.

Transcribed text is appended to the editor, preserving your existing draft, and is **never sent automatically**. Optional cleanup may rephrase your words; always review the result before sending.
Recordings are sent to MiMo. When cleanup is enabled, the transcript is also sent to a MiMo text model. Microphone checks run entirely locally without API calls.

More information (in Chinese): [Recording & troubleshooting](docs/audio.md) · [Transcript cleanup](docs/text-cleanup.md) · [Development & publishing](docs/development.md) · [Changelog](CHANGELOG.md) · [MIT license](LICENSE)

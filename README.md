# Browser Audio Testkit

`@meaningfool/browser-audio-testkit` owns one isolated full Chromium context and
one ordinary Playwright page. It supplies WAV microphone input and captures the
tab's live audio to WebM/Opus. It requires no application services or provider
account.

This is the extraction baseline for
[EventPulse #686](https://github.com/meaningfool/eventpulse/issues/686).
Playback requires active recording. Finishing recording disposes page audio;
playback cannot resume afterward. Independent audio lifetimes and the optional
Playwright fixture are subsequent work, not supported by this version.

## Use a local packed build

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm pack --pack-destination /tmp
# In your consuming project:
npm install /tmp/meaningfool-browser-audio-testkit-0.0.0.tgz
```

```ts
import { createVoiceBrowserSession } from '@meaningfool/browser-audio-testkit';

const session = await createVoiceBrowserSession({
  origin: 'https://application.example',
  outputDir: '/absolute/path/to/unique-output',
});
try {
  await session.page.goto('https://application.example/');
  await session.startRecording();
  // The application's own getUserMedia({audio:true}) receives the synthetic mic.
  const clip = await session.playWav('/absolute/path/to/input.wav', {
    requireLiveMicrophone: true,
  });
  console.log(await clip.progress());
  console.log(await clip.completed);
  console.log(await session.readState());
  const recording = await session.stopRecording();
  console.log(recording.capturePath);
} finally {
  await session.close();
}
```

The output directory must not already contain `capture.webm`. The session writes
that file plus `capture.json`, with restricted file permissions. The caller owns
retention and unique output paths. The baseline creates the capture file during
setup, even when recording is never started. One recording is supported per
session. `close()` is repeatable and flushes active recording before releasing the
browser, temporary profile, upload server and file handle. Setup and teardown
errors reject; preserve a test's original failure if cleanup also rejects.

`showBrowser` and `listenLive` default to false and are independent options.
Successful active tab capture diverts host playback; `listenLive: true` connects
the captured stream to the extension's output. This baseline's silent guarantee
starts with recording activation: navigate an inert page and start recording
before application audio. It does not suppress immediate page sound before that
point. `ignoreHTTPSErrors` defaults to false. `operationTimeoutMs` defaults to
10,000 and accepts a positive value up to 60,000. The core `origin` guards recording
startup; it is not Playwright's `baseURL`.

The exposed `context` accepts ordinary routing, permissions and other Playwright
configuration. This session does not inherit a test runner's launch/context
options. Additional pages are outside its audio guarantee. Audio-only
`getUserMedia` requests are substituted; physical devices and video requests
are unavailable. WAV decoding uses Chromium's `decodeAudioData`.

`VoiceClip` exposes completion, local progress and explicit stop. The microphone
reference in a capture proves local playback, not receipt by an application or
provider. `readState()` observes synthetic microphone tracks and the narrow
MediaStream-backed `<audio>` output scope. Its meters do not certify host sound
or provider behavior.

## Verify

```sh
pnpm check
pnpm test
```

Verification packs and installs the built artifact in a temporary consumer
outside this source tree. Package-owned verification generates a 440 Hz PCM WAV,
sends it to a real WebRTC receiver, verifies continued received silence using
RTP/sample/concealment statistics, exercises progress and stopping, observes a
MediaStream-backed audio element, and decodes the actual tab recording with
`ffmpeg`. An independent 880 Hz page oscillator must also be present in that
capture. Separate checks cover missing-browser setup and cleanup after a
consumer failure. Silent/live routing is checked through the real browser’s
WebAudio output connection and native active tab capture, independently of the
library’s monitoring flag; this is browser routing evidence, not a host speaker
recording. Tests require `ffmpeg` on PATH and a Chromium download.

The tested combination is Node 26.0.0, Playwright 1.63.0, and its bundled full
Chromium 153.0.8010.12 on macOS arm64. Full Chromium 153+ is required by the extension
activation path (`Extensions.triggerAction`); headless shell is unsupported.
This does not establish compatibility with every later version or with Linux/CI.
Browser tests may need permission to launch isolated subprocesses and bind a
loopback server. They never use a personal browser profile.

## Provenance and release

Extracted from `meaningfool/eventpulse`, revision
`df7d3ecf7d08fb47f5825c165505c1ef66eb308f`, directory
`tests/voice-interview/voice-browser`, tree
`5b07c8fe4a89c12274fdb9d92d1d3901a232c147`.
The injected microphone script and complete extension are retained. Names and
imports are generic; application speech, authentication, services, provider
interpretation and retention remain consumer-owned. No source LICENSE, NOTICE
or copyright headers were present in the extracted directory. License and
versioned distribution are pending the explicit release decision in
[EventPulse #688](https://github.com/meaningfool/eventpulse/issues/688).
This package has not been published to a registry.

# Browser Audio Testkit

`@meaningfool/browser-audio-testkit` owns one isolated full Chromium context and
one ordinary Playwright page. It supplies WAV microphone input and captures the
tab's live audio to WebM/Opus. It requires no application services or provider
account.

Microphone playback, listening and recording have independent lifetimes. Capture
routing is prepared on an inert bootstrap before the page is exposed, so the
first application navigation obeys the listening policy. Recording is optional
and saves one selected interval. The Playwright fixture is subsequent work.

## Use a local packed build

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm pack --pack-destination /tmp
# In your consuming project:
npm install /tmp/meaningfool-browser-audio-testkit-0.0.0.tgz
```

```ts
import { createVoiceBrowserSession } from "@meaningfool/browser-audio-testkit";

const session = await createVoiceBrowserSession({
  origin: "https://application.example",
  outputDir: "/absolute/path/to/unique-output",
});
try {
  await session.page.goto("https://application.example/");
  // The application's own getUserMedia({audio:true}) receives the synthetic mic.
  const clip = await session.playWav("/absolute/path/to/input.wav", {
    requireLiveMicrophone: true,
  });
  // Start saving while the clip and application output are already running.
  await session.startRecording();
  console.log(await clip.progress());
  console.log(await clip.completed);
  console.log(await session.readState());
  const recording = await session.stopRecording();
  console.log(
    recording.capturePath,
    recording.bytes,
    recording.stoppedAtUnixMs,
  );
  // Finishing preserves audio and listening. Further clips remain usable.
  await (
    await session.playWav("/absolute/path/to/another.wav")
  ).completed;
} finally {
  await session.close();
}
```

The caller owns unique output paths and artifact retention. The session creates
`capture.webm` and `capture.json` with restricted permissions only when recording
is requested, and rejects existing files. A session that never records leaves
no capture artifacts. Only one recording is supported. `RecordingMetadata` is
`RecordingStarted | RecordingFinished`; numeric byte/chunk counts are always
present, and final timestamps are required on the finished variant. Finalization
verifies accepted bytes, closes the capture and persists metadata before success.

`close()` is repeatable and flushes active recording before releasing the browser,
temporary profile, upload server and file handles. Finishing before recording
starts rejects without preventing a later start. Concurrent starts allocate at
most one recorder; repeated finish and release share their result or failure.
Setup and teardown errors reject; preserve a test's original failure if cleanup
also rejects. Capture loss fails the environment and mutes or closes the owned tab;
recovered partial bytes are never reported as a successful finished recording.

`showBrowser` and `listenLive` default to false and are independent options.
Persistent native tab capture diverts local playback; `listenLive: true` connects
the captured stream to the extension's output. Routing remains active before,
during and after recording. `ignoreHTTPSErrors` defaults to false.
`operationTimeoutMs` defaults to 10,000 and accepts a positive finite value up to
60,000. Browser launch has a 30-second budget; capture activation/flush and context
close have 15-second budgets; server close has a 3-second budget. Clip completion
is bounded by its decoded duration plus 10 seconds.

The core `origin` guards WAV playback and recording startup; it is not Playwright's
`baseURL`. Navigation and authentication remain consumer-owned. Finalization,
stopping and release remain available after leaving that origin. Same-document
navigation preserves clips; full navigation prepares fresh document-local state.
Old clip handles reject on interruption and cannot address a new document's reused
ID. Active tab recording survives ordinary navigation on the same exposed Page.

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
capture. Frequencies emitted before and after the selected interval must remain
absent after a 250ms source-settling allowance before recording. Checks also cover
optional recording without artifacts, same/full navigation, document interruption,
concurrent lifecycle calls, microphone cutoff, media playback controls, upload and
file-allocation failures, bounded startup with a paused document, missing-browser
setup and cleanup after consumer failure.
Silent/live routing is checked through the real browser’s
WebAudio output connection and native active tab capture, independently of the
library’s monitoring flag, before first navigation and after finishing. Destroying
the native capture document must mute or close the tab and reject new audio work.
This is browser routing evidence, not a host speaker
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
or copyright headers were present in the extracted directory. MIT licensing and
a versioned `.tgz` GitHub Release asset were selected for
[EventPulse #688](https://github.com/meaningfool/eventpulse/issues/688).
The license file and first release are delivered by that issue; the first release
will not use npm. This package has not been published to a registry.

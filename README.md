# Browser Audio Testkit

`@meaningfool/browser-audio-testkit` owns one isolated full Chromium context and
one ordinary Playwright page. It supplies WAV microphone input and captures the
tab's live audio to WebM/Opus. It requires no application services or provider
account.

Microphone playback, listening and recording have independent lifetimes. Capture
routing is prepared on an inert bootstrap before the page is exposed, so the
first application navigation obeys the listening policy. Recording is optional
and saves one selected interval. The optional Playwright fixture owns automatic setup
and release on the same ordinary page.

## Install version 0.1.0

The first distribution is the MIT-licensed tarball on the public
[GitHub release](https://github.com/meaningfool/browser-audio-testkit/releases/tag/v0.1.0):

```sh
npm install https://github.com/meaningfool/browser-audio-testkit/releases/download/v0.1.0/meaningfool-browser-audio-testkit-0.1.0.tgz
npx playwright install chromium
```

Commit the generated lockfile: it retains the exact release URL and package
integrity. Use `npm ci` for subsequent installs. The package pins Playwright,
Playwright Core and its test runner to 1.63.0; use that same version in the
consumer. There is no npm registry publication for this release. A local release
candidate can be installed from its absolute tarball path using the same commands.

## Explicit API

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

## Playwright fixture

```ts
import { test, expect } from "@meaningfool/browser-audio-testkit/playwright";

test.use({
  voiceBrowserOptions: { origin: "https://application.example" },
});

test("navigate, then explicitly exercise audio", async ({ page, context, voiceBrowser }) => {
  expect(page).toBe(voiceBrowser.page);
  expect(context).toBe(voiceBrowser.context);
  await page.goto("https://application.example/");
  // Sign in and navigate on this same page using consumer-owned helpers.
  await voiceBrowser.startRecording();
  const clip = await voiceBrowser.playWav("/absolute/path/to/input.wav");
  expect((await clip.completed).state).toBe("completed");
  expect((await voiceBrowser.stopRecording()).state).toBe("finished");
  // Automatic teardown calls the core close(), including after test failure.
});
```

`voiceBrowser` is test-scoped. Its `page` and `context` are the runner fixtures'
ordinary Playwright objects, with no duplicate browser launched. Consumers may
further extend the exported `test` as usual. Setup neither navigates to your
application nor selects clips or starts recording. The origin is required via
`test.use` or the project's `use.voiceBrowserOptions`.

`VoiceBrowserFixtureOptions` is the core options type excluding `outputDir`:
origin, showBrowser, listenLive, ignoreHTTPSErrors and operationTimeoutMs.
Only these named options configure the owned environment. Stock storageState,
device, launch, tracing, video, context, timeouts and baseURL settings are not
inherited. Always navigate using absolute URLs; authentication, routing and
context configuration remain consumer-owned. If explicitly requested, the stock
`browser` fixture launches a separate browser with its usual settings.

Playwright 1.63 applies global defaults and artifact hooks to its shared client,
including persistent contexts. A small private adapter creates a fresh in-process
Playwright client through `playwright-core/lib/coreBundle`. This undocumented
compatibility seam is isolated and pinned to 1.63.0; installed-package checks
exercise option isolation and separate stock-browser behavior. Upgrade these
three dependencies together only after rerunning those checks.

Artifacts go to `testInfo.outputPath("browser-audio")`, unique across parallel
tests and retries. No recording means no capture artifacts. Consumers own report
attachments and retention. The fixture preserves a body failure and reports
cleanup errors alongside it. It does not patch native page/context close methods
or install process signal handlers.

Acquisition and release have separate 60-second fixture allowances, independent
of the body timeout. Preparation uses a 38-second aggregate deadline with bounded
browser operations. Failed setup has no recording file handles: the reserved
21 seconds covers context close (15s), server close (3s) and profile removal (3s),
with later cleanup stages still attempted after an earlier failure. Recording flush and
persistence share a 15-second deadline; subsequent release stages retain their
own bounds. The owning runner must allow teardown before forced termination
(a 65-second shutdown grace covers the release allowance). Abrupt process
termination cannot guarantee a flushed recording.

## Verify

```sh
pnpm check
pnpm test
```

Verification packs and installs the built artifact in a temporary consumer
outside this source tree. It also runs a Playwright consumer journey covering
page/context identity, stock-option isolation, separate stock browser, extension,
active-recording failure/timeout cleanup, original plus cleanup errors and
parallel/retry output isolation. Package-owned verification generates a 440 Hz PCM WAV,
sends it to a real WebRTC receiver, verifies continued received silence using
RTP/sample/concealment statistics, exercises progress and stopping, observes a
MediaStream-backed audio element, and decodes the actual tab recording with
`ffmpeg`. An independent 880 Hz page oscillator must also be present in that
capture. Frequencies emitted before and after the selected interval must remain
absent after a 250ms source-settling allowance before recording. Checks also cover
optional recording without artifacts, same/full navigation, document interruption,
concurrent lifecycle calls including accepted startup longer than the flush budget,
microphone cutoff, media playback controls, upload and
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
The license is included in the package. No registry publication is required.

## Prepare and publish a release

From the reviewed checkout with Node 26.0.0, pnpm 10.13.1, ffmpeg and the
Playwright 1.63.0 full Chromium download installed:

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm release:candidate
```

This checks types, verifies an external installed tarball through the full core
and fixture suites, builds twice, verifies byte-identical packages and writes
`release/meaningfool-browser-audio-testkit-0.1.0.tgz` and `release/SHA256SUMS`.
Neither preparation nor packing publishes anything.

After the reviewed change is merged, create the numbered GitHub release from the
exact merged commit and upload these two files:

```sh
gh release create v0.1.0 release/meaningfool-browser-audio-testkit-0.1.0.tgz release/SHA256SUMS --repo meaningfool/browser-audio-testkit --target MERGED_COMMIT_SHA --title "Browser Audio Testkit 0.1.0" --notes "MIT-licensed explicit API and Playwright fixture. Verified on macOS arm64 with Node 26.0.0, Playwright 1.63.0 and full Chromium 153.0.8010.12."
pnpm verify:artifact https://github.com/meaningfool/browser-audio-testkit/releases/download/v0.1.0/meaningfool-browser-audio-testkit-0.1.0.tgz
```

The final command installs the actual release URL into a new temporary consumer,
typechecks both entrypoints and reruns all core/fixture checks. Its generated
lockfile records the downloaded asset's integrity. Failed consumer evidence is
retained at the printed temporary path; successful consumers are removed.
Release acceptance requires this downloaded-asset check to pass.

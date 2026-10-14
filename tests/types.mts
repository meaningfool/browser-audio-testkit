import { createVoiceBrowserSession, type VoiceBrowserSession, type VoiceClip, type RecordingMetadata, type RecordingStarted, type RecordingFinished, type VoiceBrowserState } from '@meaningfool/browser-audio-testkit';
async function consumer(): Promise<void> {
  const session: VoiceBrowserSession = await createVoiceBrowserSession({ origin: 'https://neutral.invalid', outputDir: '/tmp/unique-output', operationTimeoutMs: 5000 });
  const clip: VoiceClip = await session.playWav('/tmp/tone.wav');
  const progress = await clip.progress();
  const state: VoiceBrowserState = await session.readState();
  const started: RecordingStarted = await session.startRecording();
  const finished: RecordingFinished = await session.stopRecording();
  const stoppedAt: number = finished.stoppedAtUnixMs;
  const uploadedAt: number = finished.uploadedAtUnixMs;
  const bytes: number = started.bytes;
  const chunks: number = started.chunkCount;
  const metadata: RecordingMetadata = Math.random() ? started : finished;
  if (metadata.state === 'finished') {
    const complete: number = metadata.uploadedAtUnixMs + metadata.stoppedAtUnixMs;
    console.log(complete);
  } else {
    // @ts-expect-error A started recording does not certify completion timestamps.
    const incomplete: number = metadata.stoppedAtUnixMs;
    console.log(incomplete);
  }
  console.log(progress.elapsedSamples, state.microphoneTracks, metadata.capturePath, stoppedAt, uploadedAt, bytes, chunks);
  await session.close();
}
void consumer;

import { test, expect, type VoiceBrowserFixtureOptions } from '@meaningfool/browser-audio-testkit/playwright';
const fixtureOptions: VoiceBrowserFixtureOptions = { origin: 'https://neutral.invalid' };
// @ts-expect-error Fixture artifact paths belong to the runner, not callers.
const invalidOutput: VoiceBrowserFixtureOptions = { origin: 'https://neutral.invalid', outputDir: '/tmp/shared' };
test.use({ voiceBrowserOptions: fixtureOptions });
const extended = test.extend<{ journey: string }>({
  journey: async ({ page }, use) => { await use(page.url()); },
});
extended('typed fixture', async ({ page, context, voiceBrowser, journey }) => {
  expect(page).toBe(voiceBrowser.page);
  expect(context).toBe(voiceBrowser.context);
  const url: string = journey;
  console.log(url);
});
void invalidOutput;

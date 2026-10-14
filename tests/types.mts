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

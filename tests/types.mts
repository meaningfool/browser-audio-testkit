import { createVoiceBrowserSession, type VoiceBrowserSession, type VoiceClip, type RecordingMetadata, type VoiceBrowserState } from '@meaningfool/browser-audio-testkit';
async function consumer(): Promise<void> {
  const session: VoiceBrowserSession = await createVoiceBrowserSession({ origin: 'https://neutral.invalid', outputDir: '/tmp/unique-output' });
  const clip: VoiceClip = await session.playWav('/tmp/tone.wav');
  const progress = await clip.progress();
  const state: VoiceBrowserState = await session.readState();
  const metadata: RecordingMetadata = await session.stopRecording();
  console.log(progress.elapsedSamples, state.microphoneTracks, metadata.capturePath);
  await session.close();
}
void consumer;

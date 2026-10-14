import { createSession } from "./session.js";
import type { VoiceBrowserOptions, VoiceBrowserSession } from "./types.js";
export type {
  AudioMeter,
  ClipPlayback,
  MicrophoneTrack,
  PlayWavOptions,
  RecordingStarted,
  RecordingFinished,
  RecordingMetadata,
  VoiceBrowserOptions,
  VoiceBrowserSession,
  VoiceBrowserState,
  VoiceClip,
} from "./types.js";

/** Prepare one owned full Chromium environment, without a Playwright runner. */
export function createVoiceBrowserSession(
  options: VoiceBrowserOptions,
): Promise<VoiceBrowserSession> {
  return createSession(options);
}

import type { BrowserContext, Page } from "playwright";

export interface VoiceBrowserOptions {
  origin: string;
  outputDir: string;
  showBrowser?: boolean;
  listenLive?: boolean;
  /** Tab input is the independent WAV reference by default, or an actual returned microphone track. */
  captureInput?: "reference" | "microphone";
  ignoreHTTPSErrors?: boolean;
  operationTimeoutMs?: number;
}

export interface MicrophoneTrack {
  id: string;
  enabled: boolean;
  muted: boolean;
  readyState: "live" | "ended";
}

export interface AudioMeter {
  sampledFrames: number;
  nonzeroFrames: number;
  rms: number;
  maxRms: number;
  peak: number;
  firstNonzeroAtUnixMs: number | null;
  lastNonzeroAtUnixMs: number | null;
}

export interface ClipPlayback {
  id: string;
  durationSeconds: number;
  sampleRate: number;
  totalSamples: number;
  elapsedSamples: number;
  elapsedSeconds: number;
  playedSeconds: number;
  startedAtUnixMs: number;
  startedAudioContextSeconds: number;
  endedAtUnixMs: number | null;
  state: "playing" | "completed" | "stopped";
  microphoneCutoffSeconds: number | null;
  microphoneCutoffAtUnixMs: number | null;
  microphoneCutoffAudioContextSeconds: number | null;
}

export interface VoiceBrowserState {
  microphoneRequests: number;
  microphoneRequestedAtUnixMs: number | null;
  track: MicrophoneTrack | null;
  microphoneTracks: MicrophoneTrack[];
  trackTransitions: (MicrophoneTrack & {
    atUnixMs: number;
    audioContextSeconds: number;
  })[];
  microphone: AudioMeter;
  incoming: AudioMeter & {
    observedAtUnixMs: number | null;
    sourceRms: number;
    playingEvents: number;
    currentTime: number;
    muted: boolean | null;
    paused: boolean | null;
    volume: number | null;
    connectedToDocument: boolean;
    hasStream: boolean;
    active: boolean;
    transitions: { active: boolean; atUnixMs: number; rms: number }[];
  };
  clips: ClipPlayback[];
  disposed: boolean;
  errors: string[];
}

export interface PlayWavOptions {
  id?: string;
  requireLiveMicrophone?: boolean;
}

export interface VoiceClip {
  readonly id: string;
  readonly durationSeconds: number;
  readonly startedAtUnixMs: number;
  readonly startedAudioContextSeconds: number;
  readonly completed: Promise<ClipPlayback>;
  progress(): Promise<ClipPlayback>;
  stop(): Promise<ClipPlayback>;
}

interface RecordingFields {
  captureInput: "reference" | "microphone";
  tabId: number;
  mimeType: string;
  monitorConnected: boolean;
  monitor: {
    contextState: string;
    sampleRate: number;
    maxRms: number;
    nonzeroSamples: number;
    samples: number;
  } | null;
  capture: AudioMeter;
  audioTracks: {
    kind: string;
    readyState: string;
    settings: Record<string, string | number | boolean>;
  }[];
  videoTracks: number;
  startedAtUnixMs: number;
  chunkCount: number;
  bytes: number;
  capturePath: string;
}

export interface RecordingStarted extends RecordingFields {
  state: "recording";
}

export interface RecordingFinished extends RecordingFields {
  state: "finished";
  stoppedAtUnixMs: number;
  uploadedAtUnixMs: number;
}

export type RecordingMetadata = RecordingStarted | RecordingFinished;

export interface VoiceBrowserSession {
  readonly page: Page;
  readonly context: BrowserContext;
  readonly browserVersion: string;
  readonly outputDir: string;
  startRecording(): Promise<RecordingStarted>;
  playWav(path: string, options?: PlayWavOptions): Promise<VoiceClip>;
  readState(): Promise<VoiceBrowserState>;
  stopPlayback(): Promise<VoiceBrowserState>;
  stopRecording(): Promise<RecordingFinished>;
  close(): Promise<void>;
}

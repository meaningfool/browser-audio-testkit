// An independent live tab stream supplies every recorded sample.
let stream;
let recorder;
let captureContext;
let source;
let analyser;
let timer;
let metadata;
let uploadUrl;
let uploads = Promise.resolve();
let uploadError;
let recordingStopped;

function sample() {
  if (!metadata || recorder.state !== "recording") return;
  const samples = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(samples);
  let squares = 0;
  let peak = 0;
  for (const value of samples) {
    squares += value * value;
    peak = Math.max(peak, Math.abs(value));
  }
  const rms = Math.sqrt(squares / samples.length);
  metadata.capture.sampledFrames++;
  metadata.capture.rms = rms;
  metadata.capture.maxRms = Math.max(metadata.capture.maxRms, rms);
  metadata.capture.peak = Math.max(metadata.capture.peak, peak);
  if (rms > 0.001) {
    metadata.capture.nonzeroFrames++;
    metadata.capture.firstNonzeroAtUnixMs ??= Date.now();
    metadata.capture.lastNonzeroAtUnixMs = Date.now();
  }
  if (metadata.monitor) {
    metadata.monitor.samples++;
    metadata.monitor.maxRms = Math.max(metadata.monitor.maxRms, rms);
    if (rms > 0.001) metadata.monitor.nonzeroSamples++;
  }
}

async function activate(message) {
  stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: message.streamId,
      },
    },
    video: false,
  });
  if (stream.getAudioTracks().length !== 1 || stream.getVideoTracks().length)
    throw new Error("Expected one live audio capture track and no video");
  captureContext = new AudioContext();
  source = captureContext.createMediaStreamSource(stream);
  analyser = captureContext.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);
  // With no monitor, tabCapture diverts local playback and the host remains silent.
  if (message.listenLive) source.connect(captureContext.destination);
  await captureContext.resume();
  stream.getAudioTracks()[0].addEventListener("ended", () => {
    void chrome.runtime.sendMessage({
      target: "controller",
      type: "captureLost",
    });
  });
  return { monitorConnected: message.listenLive };
}

async function start(message) {
  uploadUrl = message.uploadUrl;
  if (!stream?.active) throw new Error("Tab capture is no longer live");
  recorder = new MediaRecorder(stream, {
    mimeType: "audio/webm;codecs=opus",
    audioBitsPerSecond: 128000,
  });
  metadata = {
    tabId: message.tabId,
    mimeType: recorder.mimeType,
    monitorConnected: message.listenLive,
    monitor: message.listenLive
      ? {
          contextState: captureContext.state,
          sampleRate: captureContext.sampleRate,
          maxRms: 0,
          nonzeroSamples: 0,
          samples: 0,
        }
      : null,
    capture: {
      sampledFrames: 0,
      nonzeroFrames: 0,
      rms: 0,
      maxRms: 0,
      peak: 0,
      firstNonzeroAtUnixMs: null,
      lastNonzeroAtUnixMs: null,
    },
    audioTracks: stream.getAudioTracks().map((track) => ({
      kind: track.kind,
      readyState: track.readyState,
      settings: track.getSettings(),
    })),
    videoTracks: stream.getVideoTracks().length,
    startedAtUnixMs: Date.now(),
    chunkCount: 0,
    bytes: 0,
  };
  recorder.addEventListener("dataavailable", ({ data }) => {
    if (!data.size) return;
    metadata.chunkCount++;
    metadata.bytes += data.size;
    uploads = uploads
      .then(async () => {
        if (uploadError) return;
        const response = await fetch(uploadUrl, {
          method: "POST",
          body: data,
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok)
          throw new Error(`Capture chunk upload failed: ${response.status}`);
        metadata.uploadedAtUnixMs = Date.now();
      })
      .catch((error) => {
        uploadError = error;
      });
  });
  // A disappearing tab can end capture before the controller requests teardown.
  // Retain that stop event so final chunks can still be flushed exactly once.
  recordingStopped = new Promise((resolve, reject) => {
    recorder.addEventListener(
      "stop",
      () => {
        metadata.stoppedAtUnixMs = Date.now();
        resolve();
      },
      { once: true },
    );
    recorder.addEventListener("error", ({ error }) => reject(error), {
      once: true,
    });
  });
  void recordingStopped.catch(() => undefined);
  await new Promise((resolve, reject) => {
    recorder.addEventListener("start", resolve, { once: true });
    recorder.addEventListener("error", ({ error }) => reject(error), {
      once: true,
    });
    recorder.start(250);
  });
  timer = setInterval(sample, 20);
  return metadata;
}

async function stop() {
  if (recorder.state !== "inactive") {
    recorder.stop();
  }
  await recordingStopped;
  clearInterval(timer);
  try {
    await uploads;
    if (uploadError) throw uploadError;
    if (!metadata.bytes) throw new Error("Browser produced an empty capture");
    return metadata;
  } finally {
    clearInterval(timer);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message.target !== "recorder") return;
  const operation =
    message.type === "activate"
      ? activate(message)
      : message.type === "silence"
        ? Promise.resolve().then(() => {
            try {
              source?.disconnect(captureContext.destination);
            } catch (error) {
              if (error.name !== "InvalidAccessError") throw error;
            }
          })
        : message.type === "release"
          ? (async () => {
              clearInterval(timer);
              stream?.getTracks().forEach((track) => track.stop());
              source?.disconnect();
              await captureContext?.close();
            })()
          : message.type === "start"
            ? start(message)
            : message.type === "stop"
              ? stop()
              : Promise.reject(new Error("Unknown recorder operation"));
  operation.then(
    (result) => respond({ ok: true, metadata: result }),
    (error) => respond({ ok: false, error: String(error) }),
  );
  return true;
});

// Injected before application code. Only microphone hardware is substituted.
((captureInput) => {
  if (window.__voiceBrowser) return;
  const NativeAudioContext = window.AudioContext;
  const pageContexts = new Set();
  window.AudioContext = class extends NativeAudioContext {
    constructor(...args) {
      super(...args);
      pageContexts.add(this);
    }
  };
  const meter = () => ({
    sampledFrames: 0,
    nonzeroFrames: 0,
    rms: 0,
    maxRms: 0,
    peak: 0,
    firstNonzeroAtUnixMs: null,
    lastNonzeroAtUnixMs: null,
  });
  const state = {
    microphoneRequests: 0,
    microphoneRequestedAtUnixMs: null,
    track: null,
    microphoneTracks: [],
    trackTransitions: [],
    microphone: meter(),
    incoming: {
      ...meter(),
      observedAtUnixMs: null,
      sourceRms: 0,
      playingEvents: 0,
      currentTime: 0,
      muted: null,
      paused: null,
      volume: null,
      connectedToDocument: false,
      hasStream: false,
      active: false,
      transitions: [],
    },
    clips: [],
    disposed: false,
    errors: [],
  };
  let context;
  let destination;
  let microphoneSilence;
  let microphoneAnalyser;
  let microphoneSamples;
  let microphoneSource;
  const tracks = [];
  const microphoneSources = new Map();
  const clipRecords = new Map();
  const usedClipIds = new Set();
  const audioElements = new Set();
  const remoteMeters = new Map();
  let observerContext;
  let timer;

  function ensureContext() {
    if (state.disposed) throw new Error("Voice browser audio has been disposed");
    if (!context) {
      context = new NativeAudioContext({ sampleRate: 48000 });
      destination = context.createMediaStreamDestination();
      // An unconnected MediaStreamDestination emits no frames between finite clips.
      // Keep the microphone clock running so WebRTC sends real silence for VAD.
      microphoneSilence = context.createConstantSource();
      microphoneSilence.offset.value = 0;
      microphoneSilence.connect(destination);
      microphoneSilence.start();
      microphoneAnalyser = context.createAnalyser();
      microphoneAnalyser.fftSize = 2048;
      microphoneSamples = new Float32Array(microphoneAnalyser.fftSize);
      const sink = context.createGain();
      sink.gain.value = captureInput === "microphone" ? 1 : 0;
      microphoneAnalyser.connect(sink);
      sink.connect(context.destination);
    }
    return context;
  }
  function liveMicrophone() {
    return tracks.some((track) => track.enabled && track.readyState === "live");
  }
  function elapsedSamples(clip) {
    const seconds = Math.max(0, context.currentTime - clip.startedAudioContextSeconds);
    return Math.min(clip.totalSamples, Math.round(seconds * clip.sampleRate));
  }
  function progress(record) {
    if (record.clip.state === "playing") {
      record.clip.elapsedSamples = elapsedSamples(record.clip);
      record.clip.elapsedSeconds = record.clip.elapsedSamples / record.clip.sampleRate;
      record.clip.playedSeconds = record.clip.elapsedSeconds;
    }
    return structuredClone(record.clip);
  }
  function routeMicrophone() {
    // Every acquisition receives the same synthetic signal. Route one actual
    // enabled/live returned track, so repeated acquisitions never amplify it.
    const track = tracks.findLast((item) => item.enabled && item.readyState === "live");
    const source = microphoneSources.get(track);
    if (source !== microphoneSource) {
      microphoneSource?.disconnect();
      microphoneSource = source;
      microphoneSource?.connect(microphoneAnalyser);
    }
    for (const [item, node] of microphoneSources) {
      if (item.readyState === "ended") {
        node.disconnect();
        microphoneSources.delete(item);
      }
    }
  }
  function sampleTracks() {
    const next = tracks.map((track) => ({
      id: track.id,
      enabled: track.enabled,
      muted: track.muted,
      readyState: track.readyState,
    }));
    const audioContextSeconds = context?.currentTime ?? 0;
    for (const track of next) {
      const previous = state.microphoneTracks.find((item) => item.id === track.id);
      if (
        !previous ||
        previous.enabled !== track.enabled ||
        previous.readyState !== track.readyState ||
        previous.muted !== track.muted
      ) {
        state.trackTransitions.push({ ...track, atUnixMs: Date.now(), audioContextSeconds });
      }
    }
    state.microphoneTracks = next;
    state.track = next.at(-1) ?? null;
    routeMicrophone();
    if (!liveMicrophone()) {
      for (const record of clipRecords.values()) {
        const clip = record.clip;
        if (clip.state !== "playing" || clip.microphoneCutoffSeconds !== null) continue;
        clip.microphoneCutoffSeconds = elapsedSamples(clip) / clip.sampleRate;
        clip.microphoneCutoffAtUnixMs = Date.now();
        clip.microphoneCutoffAudioContextSeconds = audioContextSeconds;
      }
    }
  }
  function observeTrack(track) {
    tracks.push(track);
    // These are harness-owned tracks. Capture the local stop/disable clock at the action,
    // avoiding a Node polling delay in cutoff assertions.
    const enabled = Object.getOwnPropertyDescriptor(MediaStreamTrack.prototype, "enabled");
    if (enabled?.get && enabled?.set) {
      Object.defineProperty(track, "enabled", {
        configurable: true,
        get: () => enabled.get.call(track),
        set: (value) => {
          enabled.set.call(track, value);
          sampleTracks();
        },
      });
    }
    const stop = track.stop.bind(track);
    track.stop = () => {
      stop();
      sampleTracks();
    };
    track.addEventListener("ended", sampleTracks);
    sampleTracks();
  }
  function measure(analyser, samples) {
    analyser.getFloatTimeDomainData(samples);
    let peak = 0;
    let squares = 0;
    for (const value of samples) {
      peak = Math.max(peak, Math.abs(value));
      squares += value * value;
    }
    return { rms: Math.sqrt(squares / samples.length), peak };
  }
  function updateMeter(target, values) {
    target.sampledFrames++;
    target.rms = values.rms;
    target.maxRms = Math.max(target.maxRms, values.rms);
    target.peak = Math.max(target.peak, values.peak);
    if (values.rms > 0.001) {
      target.nonzeroFrames++;
      target.firstNonzeroAtUnixMs ??= Date.now();
      target.lastNonzeroAtUnixMs = Date.now();
    }
  }
  function observeAudio() {
    for (const element of document.querySelectorAll("audio")) {
      if (!audioElements.has(element)) {
        audioElements.add(element);
        element.addEventListener("playing", () => {
          state.incoming.playingEvents++;
        });
      }
    }
    let latest;
    let sourceRms = 0;
    let effectiveRms = 0;
    let peak = 0;
    for (const element of audioElements) {
      let remote = remoteMeters.get(element);
      const stream = element.srcObject;
      if (stream instanceof MediaStream && (!remote || remote.stream !== stream)) {
        if (remote) remote.source.disconnect();
        try {
          observerContext ??= new NativeAudioContext();
          const source = observerContext.createMediaStreamSource(stream);
          const analyser = observerContext.createAnalyser();
          analyser.fftSize = 2048;
          source.connect(analyser);
          remote = { stream, source, analyser, samples: new Float32Array(analyser.fftSize) };
          remoteMeters.set(element, remote);
          state.incoming.observedAtUnixMs = Date.now();
          void observerContext.resume().catch((error) => state.errors.push(String(error)));
        } catch (error) {
          state.errors.push(String(error));
        }
      }
      if (!remote) continue;
      latest = element;
      const values = measure(remote.analyser, remote.samples);
      sourceRms = Math.max(sourceRms, values.rms);
      // The stream meter alone can remain nonzero when the app has muted or paused.
      const audible =
        stream === remote.stream &&
        !element.muted &&
        !element.paused &&
        element.volume > 0 &&
        !element.ended;
      if (audible) {
        effectiveRms = Math.max(effectiveRms, values.rms * element.volume);
        peak = Math.max(peak, values.peak * element.volume);
      }
    }
    if (latest) {
      state.incoming.currentTime = latest.currentTime;
      state.incoming.muted = latest.muted;
      state.incoming.paused = latest.paused;
      state.incoming.volume = latest.volume;
      state.incoming.connectedToDocument = latest.isConnected;
      state.incoming.hasStream = latest.srcObject instanceof MediaStream;
      state.incoming.sourceRms = sourceRms;
      updateMeter(state.incoming, { rms: effectiveRms, peak });
      const active = effectiveRms > 0.001;
      if (state.incoming.active !== active) {
        state.incoming.transitions.push({ active, atUnixMs: Date.now(), rms: effectiveRms });
        state.incoming.active = active;
      }
    }
  }
  function sample() {
    sampleTracks();
    observeAudio();
    if (microphoneAnalyser) {
      const values = measure(microphoneAnalyser, microphoneSamples);
      updateMeter(state.microphone, liveMicrophone() ? values : { rms: 0, peak: 0 });
    }
  }
  // Non-secure documents (including about:blank) may not expose mediaDevices.
  // Playback stopping and state remain available after leaving the configured origin.
  if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async (constraints) => {
    if (!constraints?.audio || constraints.video) {
      throw new Error(
        "Voice browser supports only synthetic audio microphone requests; physical devices are unavailable",
      );
    }
    const ctx = ensureContext();
    await ctx.resume();
    state.microphoneRequests++;
    state.microphoneRequestedAtUnixMs = Date.now();
    const stream = destination.stream.clone();
    for (const track of stream.getAudioTracks()) {
      microphoneSources.set(track, ctx.createMediaStreamSource(new MediaStream([track])));
      observeTrack(track);
    }
    return stream;
  };

  window.__voiceBrowser = {
    state() {
      sample();
      state.clips = [...clipRecords.values()].map(progress);
      return structuredClone(state);
    },
    async playWav({ id, base64, requireLiveMicrophone }) {
      if (usedClipIds.has(id)) throw new Error(`Voice clip ID already used: ${id}`);
      usedClipIds.add(id);
      const ctx = ensureContext();
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      const buffer = await ctx.decodeAudioData(bytes.buffer);
      ensureContext();
      await ctx.resume();
      ensureContext();
      if (requireLiveMicrophone && !liveMicrophone())
        throw new Error("Synthetic microphone is not enabled and live");
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(destination);
      // Reference mode retains attempted playback after microphone shutdown.
      // Microphone mode reaches tab output only through an actual returned track.
      if (captureInput === "reference") source.connect(ctx.destination);
      let resolve;
      const completed = new Promise((finish) => {
        resolve = finish;
      });
      const clip = {
        id,
        durationSeconds: buffer.duration,
        sampleRate: buffer.sampleRate,
        totalSamples: buffer.length,
        elapsedSamples: 0,
        elapsedSeconds: 0,
        playedSeconds: 0,
        startedAtUnixMs: Date.now(),
        startedAudioContextSeconds: ctx.currentTime,
        endedAtUnixMs: null,
        state: "playing",
        microphoneCutoffSeconds: null,
        microphoneCutoffAtUnixMs: null,
        microphoneCutoffAudioContextSeconds: null,
      };
      const record = { clip, source, completed, resolve };
      clipRecords.set(id, record);
      source.addEventListener(
        "ended",
        () => {
          if (clip.state === "playing") {
            clip.elapsedSamples = buffer.length;
            clip.elapsedSeconds = buffer.duration;
            clip.playedSeconds = buffer.duration;
            clip.state = "completed";
          }
          clip.endedAtUnixMs = Date.now();
          source.disconnect();
          resolve(progress(record));
        },
        { once: true },
      );
      source.start(clip.startedAudioContextSeconds);
      sampleTracks();
      return progress(record);
    },
    clip(id) {
      const record = clipRecords.get(id);
      if (!record) throw new Error(`Unknown voice clip: ${id}`);
      return progress(record);
    },
    completed(id) {
      const record = clipRecords.get(id);
      if (!record) throw new Error(`Unknown voice clip: ${id}`);
      return record.completed;
    },
    stopClip(id) {
      const record = clipRecords.get(id);
      if (!record) throw new Error(`Unknown voice clip: ${id}`);
      if (record.clip.state === "playing") {
        progress(record);
        record.clip.state = "stopped";
        record.clip.endedAtUnixMs = Date.now();
        record.source.stop();
        record.source.disconnect();
        record.resolve(progress(record));
      }
      return progress(record);
    },
    stopPlayback() {
      for (const id of clipRecords.keys()) this.stopClip(id);
      return this.state();
    },
    async dispose() {
      if (state.disposed) return this.state();
      this.stopPlayback();
      state.disposed = true;
      clearInterval(timer);
      // Silence current and removed app audio before tabCapture restores local playback.
      for (const element of document.querySelectorAll("audio,video")) audioElements.add(element);
      for (const element of audioElements) {
        element.muted = true;
        element.pause();
      }
      await Promise.all(
        [...pageContexts].map((ctx) => (ctx.state === "closed" ? undefined : ctx.suspend())),
      );
      tracks.forEach((track) => track.stop());
      microphoneSilence?.stop();
      microphoneSilence?.disconnect();
      destination?.stream.getTracks().forEach((track) => track.stop());
      if (context?.state !== "closed" && context) await context.close();
      if (observerContext?.state !== "closed" && observerContext) await observerContext.close();
      state.disposed = true;
      return this.state();
    },
  };
  timer = setInterval(sample, 20);
})

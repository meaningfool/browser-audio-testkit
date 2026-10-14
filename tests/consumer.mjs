import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createVoiceBrowserSession } from "@meaningfool/browser-audio-testkit";
import { writeFile, readdir, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";

// Run explicitly with node --test. This uses neither application services nor a provider.
await test(
  "synthetic microphone sends silence over WebRTC after a finite tone clip",
  { timeout: 60000 },
  async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "browser-audio-verification-"));
    const profilesBefore = await readdir(tmpdir());
    const sampleRate = 48000;
    const samples = sampleRate * 2;
    const wav = Buffer.alloc(44 + samples * 2);
    wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36);
    wav.writeUInt32LE(samples * 2, 40);
    for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(8000 * Math.sin(2 * Math.PI * 440 * i / sampleRate)), 44 + 2 * i);
    await writeFile(join(outputDir, "tone.wav"), wav);
    const session = await createVoiceBrowserSession({
      origin: "https://voice-browser-verification.invalid",
      outputDir,
    });
    try {
      await session.context.route("https://voice-browser-verification.invalid/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><html><body>Microphone transport verification</body></html>",
        }),
      );
      await session.page.goto("https://voice-browser-verification.invalid/rtc");
      await session.startRecording();
      await session.page.evaluate(String.raw`(async () => {
      const sender = new RTCPeerConnection();
      const receiver = new RTCPeerConnection();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      const microphone = stream.getAudioTracks()[0];
      sender.addTrack(microphone, stream);
      const incomingStream = new Promise((resolve) => {
        receiver.addEventListener("track", (event) => resolve(event.streams[0]), { once: true });
      });
      const gather = (peer) => new Promise((resolve) => {
        if (peer.iceGatheringState === "complete") { resolve(); return; }
        peer.addEventListener("icegatheringstatechange", () => {
          if (peer.iceGatheringState === "complete") resolve();
        });
      });
      await sender.setLocalDescription(await sender.createOffer());
      await gather(sender);
      await receiver.setRemoteDescription(sender.localDescription);
      await receiver.setLocalDescription(await receiver.createAnswer());
      await gather(receiver);
      await sender.setRemoteDescription(receiver.localDescription);
      const incoming = await incomingStream;
      // The ordinary audio consumer makes the receiving browser decode actual RTP.
      const audio = document.createElement("audio");
      audio.srcObject = incoming;
      audio.volume = 0.1;
      document.body.append(audio);
      await new Promise(resolve => setTimeout(resolve, 100));
      await audio.play();
      const context = new AudioContext();
      await context.resume();
      const source = context.createMediaStreamSource(incoming);
      const analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      const values = new Float32Array(analyser.fftSize);
      let maxRms = 0;
      let rms = 0;
      const timer = setInterval(() => {
        analyser.getFloatTimeDomainData(values);
        let sum = 0;
        for (const value of values) sum += value * value;
        rms = Math.sqrt(sum / values.length);
        maxRms = Math.max(maxRms, rms);
      }, 20);
      window.microphoneVerification = {
        async snapshot() {
          const sendStats = [...await sender.getStats()].map((entry) => entry[1]);
          const receiveStats = [...await receiver.getStats()].map((entry) => entry[1]);
          const outbound = sendStats.find((item) => item.type === "outbound-rtp" && item.kind === "audio");
          const mediaSource = sendStats.find((item) => item.type === "media-source" && item.kind === "audio");
          const inbound = receiveStats.find((item) => item.type === "inbound-rtp" && item.kind === "audio");
          return {
            senderState: sender.connectionState, receiverState: receiver.connectionState,
            microphone: { enabled: microphone.enabled, readyState: microphone.readyState }, maxRms, rms,
            sent: outbound && mediaSource ? {
              packets: outbound.packetsSent, sampleSeconds: mediaSource.totalSamplesDuration,
            } : null,
            received: inbound ? { packets: inbound.packetsReceived,
              sampleSeconds: inbound.totalSamplesDuration, concealedSamples: inbound.concealedSamples,
            } : null,
          };
        },
        async dispose() { clearInterval(timer); audio.pause(); sender.close(); receiver.close(); await context.close(); },
      };
    })()`);
      assert.equal((await session.readState()).track.readyState, "live");
      await session.page.evaluate(`(() => {
        const context = new AudioContext();
        const oscillator = context.createOscillator(); oscillator.frequency.value = 880;
        const gain = context.createGain(); gain.gain.value = 0.1;
        oscillator.connect(gain); gain.connect(context.destination); oscillator.start();
        window.outputTone = { context, oscillator };
      })()`);
      const clip = await session.playWav(
        join(outputDir, "tone.wav"),
        {
          id: "tone",
          requireLiveMicrophone: true,
        },
      );
      await sleep(500);
      const progress = await clip.progress();
      assert.equal(progress.state, "playing");
      assert.ok(progress.elapsedSamples > 0 && progress.elapsedSamples < progress.totalSamples);
      assert.equal((await clip.completed).state, "completed");
      await sleep(250);
      const before = await session.page.evaluate("microphoneVerification.snapshot()");
      await sleep(2000);
      const after = await session.page.evaluate("microphoneVerification.snapshot()");

      assert.equal(before.senderState, "connected");
      assert.equal(before.receiverState, "connected");
      assert.equal(after.microphone.enabled, true);
      assert.equal(after.microphone.readyState, "live");
      assert.ok(before.maxRms > 0.005, "The receiver must decode the known tone");
      assert.ok(before.sent && after.sent, "WebRTC must expose outbound audio statistics");
      assert.ok(before.received && after.received, "WebRTC must expose inbound audio statistics");
      assert.ok(
        after.sent.packets - before.sent.packets >= 2,
        "RTP must continue after the clip ends",
      );
      assert.ok(
        after.sent.sampleSeconds - before.sent.sampleSeconds > 1.5,
        "The synthetic microphone must supply silence samples for the following two seconds",
      );
      assert.ok(
        after.received.packets - before.received.packets >= 2,
        "The receiver must receive silence packets",
      );
      assert.ok(
        after.received.sampleSeconds - before.received.sampleSeconds > 1.5,
        "The receiver must continue decoding audio during silence",
      );
      assert.ok(
        after.received.concealedSamples - before.received.concealedSamples < 4800,
        "The receiver must receive silence rather than conceal a missing two-second stream",
      );
      assert.ok(after.rms < 0.001, "The continued received stream must be silent");
      await session.page.evaluate("document.querySelector('audio').muted = true");
      await sleep(100);
      const muted = (await session.readState()).incoming;
      assert.equal(muted.muted, true);
      assert.equal(muted.active, false);
      await session.page.evaluate("document.querySelector('audio').muted = false");
      const incoming = (await session.readState()).incoming;
      assert.ok(incoming.hasStream && incoming.connectedToDocument);
      assert.ok(incoming.playingEvents > 0 && incoming.maxRms > 0.001);
      const stopped = await session.playWav(join(outputDir, "tone.wav"), { id: "stopped" });
      await sleep(200);
      assert.equal((await stopped.stop()).state, "stopped");
      assert.equal((await stopped.completed).state, "stopped");
      await session.stopPlayback();
      const recording = await session.stopRecording();
      assert.equal(recording.state, "finished");
      assert.ok(recording.bytes > 1000);
      assert.equal((await stat(recording.capturePath)).size, recording.bytes);
      assert.equal(await session.stopRecording(), recording);
      await assert.rejects(session.playWav(join(outputDir, "tone.wav")), /Start live tab capture/);
      const pcm = execFileSync("ffmpeg", ["-v", "error", "-i", recording.capturePath, "-f", "f32le", "-ac", "1", "-ar", "48000", "pipe:1"], { maxBuffer: 20_000_000 });
      const signal = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 4);
      // Frequency-selective independent decode proves both microphone reference and live page output.
      function amplitude(frequency) {
        let peak = 0;
        for (let offset = 0; offset + 4800 <= signal.length; offset += 4800) {
          let real = 0, imag = 0;
          for (let i = 0; i < 4800; i++) {
            real += signal[offset + i] * Math.cos(2 * Math.PI * frequency * i / 48000);
            imag += signal[offset + i] * Math.sin(2 * Math.PI * frequency * i / 48000);
          }
          peak = Math.max(peak, 2 * Math.hypot(real, imag) / 4800);
        }
        return peak;
      }
      assert.ok(amplitude(440) > 0.03, "Recording must contain microphone reference at 440 Hz");
      assert.ok(amplitude(880) > 0.03, "Recording must contain independently generated tab output at 880 Hz");
      assert.ok(amplitude(1500) < 0.005, "Unrelated frequency must remain absent");
      console.log(JSON.stringify({ browser: session.browserVersion, recordingBytes: recording.bytes, microphoneAmplitude: amplitude(440), outputAmplitude: amplitude(880) }));
    } finally {
      await session.close();
      await session.close();
      assert.ok(session.page.isClosed());
      assert.equal(session.context.pages().length, 0);
      assert.deepEqual((await readdir(tmpdir())).filter(name => name.startsWith("browser-audio-testkit-") && !profilesBefore.includes(name)), []);
      await rm(outputDir, { recursive: true, force: true });
    }
  },
);

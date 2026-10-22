import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { createVoiceBrowserSession } from '@meaningfool/browser-audio-testkit';
import { neutral, tone } from './helpers.mjs';

for (const captureInput of [undefined, 'microphone']) {
  await test(`decoded tab capture follows ${captureInput ?? 'default reference'} input through track and document lifetimes`, { timeout: 60000 }, async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'audio-capture-input-'));
    const session = await createVoiceBrowserSession({ origin: 'https://neutral.invalid', outputDir, captureInput });
    let verified = false;
    try {
      await neutral(session);
      const output = () => session.page.evaluate(async () => {
        const context = new AudioContext(); await context.resume();
        const oscillator = context.createOscillator(); oscillator.frequency.value = 2200;
        const gain = context.createGain(); gain.gain.value = 0.1;
        oscillator.connect(gain); gain.connect(context.destination); oscillator.start();
        window.pageAudio = { context, oscillator };
      });
      const acquire = name => session.page.evaluate(async name => {
        window[name] = (await navigator.mediaDevices.getUserMedia({ audio: true })).getAudioTracks()[0];
      }, name);
      const clip = async (frequency, seconds = 0.6) => {
        const path = join(outputDir, `${frequency}.wav`);
        await tone(path, frequency, seconds);
        return session.playWav(path);
      };
      const complete = async frequency => assert.equal((await (await clip(frequency)).completed).state, 'completed');
      await output();
      await session.startRecording();
      await complete(330); // No application microphone acquisition yet.
      await acquire('first');
      const active = await clip(440, 1);
      await sleep(600);
      await session.page.evaluate(() => { first.enabled = false; });
      const cutoff = await active.progress();
      assert.ok(cutoff.microphoneCutoffSeconds > 0 && cutoff.microphoneCutoffSeconds < 1,
        'Disabling the actual returned track must preserve the local attempted-clip cutoff clock');
      assert.equal((await active.completed).state, 'completed');
      await complete(550); // Playback is attempted, but the returned track is disabled.
      await session.page.evaluate(() => { first.enabled = true; });
      await complete(660);
      await session.page.evaluate(() => {
        first.stop();
        pageAudio.oscillator.frequency.value = 2300;
      });
      const stoppedAttempt = await clip(770);
      const attempted = await stoppedAttempt.completed;
      assert.equal(attempted.state, 'completed');
      await session.page.evaluate(() => { pageAudio.oscillator.frequency.value = 2200; });
      assert.ok(attempted.microphoneCutoffSeconds < 0.1,
        'A post-stop attempt must retain playback timing even when it adds no microphone audio');
      await assert.rejects(session.playWav(join(outputDir, '770.wav'), { requireLiveMicrophone: true }), /microphone/i);
      await acquire('older');
      await acquire('newer');
      await session.page.evaluate(() => { newer.enabled = false; });
      await complete(990); // The older actual track is still enabled/live.
      await session.page.evaluate(() => { older.enabled = false; });
      await complete(1100); // All returned tracks are disabled or ended.
      await session.page.evaluate(() => { newer.enabled = true; });
      await complete(1210);
      await session.page.evaluate(() => { older.enabled = true; });
      await complete(1320); // Two live acquisitions must not double the microphone amplitude.
      await session.page.evaluate(() => newer.stop());
      await complete(1430); // Stopping the latest track must preserve the older live track.
      await session.page.evaluate(() => older.stop());
      await complete(1540);
      await session.page.goto('https://neutral.invalid/next');
      await output();
      await complete(1650); // New document must not inherit the old microphone route.
      await acquire('fresh');
      await complete(1760);
      const recording = await session.stopRecording();
      assert.equal(recording.captureInput, captureInput ?? 'reference');
      assert.equal(JSON.parse(await readFile(join(outputDir, 'capture.json'), 'utf8')).captureInput, captureInput ?? 'reference');
      const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', recording.capturePath, '-f', 'f32le', '-ac', '1', '-ar', '48000', 'pipe:1'], { maxBuffer: 20_000_000 });
      const samples = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 4);
      function amplitude(frequency) {
        let peak = 0;
        const recent = [];
        for (let offset = 0; offset + 4800 <= samples.length; offset += 4800) {
          let real = 0, imaginary = 0;
          for (let i = 0; i < 4800; i++) {
            const windowed = samples[offset + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / 4800));
            real += windowed * Math.cos(2 * Math.PI * frequency * i / 48000);
            imaginary += windowed * Math.sin(2 * Math.PI * frequency * i / 48000);
          }
          // Hann windows and three consecutive frames distinguish a sustained
          // marker from spectral leakage at another tone's start/stop boundary.
          const current = 4 * Math.hypot(real, imaginary) / 4800;
          recent.push(current);
          if (recent.length > 3) recent.shift();
          if (recent.length === 3) peak = Math.max(peak, Math.min(...recent));
        }
        return peak;
      }
      const levels = Object.fromEntries([330, 440, 550, 660, 770, 990, 1100, 1210, 1320, 1430, 1540, 1650, 1760, 2200, 2300].map(frequency => [frequency, amplitude(frequency)]));
      console.log(JSON.stringify({ browser: session.browserVersion, captureInput: captureInput ?? 'default reference', levels }));
      for (const frequency of [440, 660, 990, 1210, 1320, 1430, 1760]) {
        assert.ok(levels[frequency] > 0.08 && levels[frequency] < 0.4,
          `${frequency} Hz must be captured once from an enabled/live microphone, including repeated acquisitions`);
      }
      for (const frequency of [330, 550, 770, 1100, 1540, 1650]) {
        if (captureInput === 'microphone') assert.ok(levels[frequency] < 0.01,
          `${frequency} Hz must be absent without an enabled/live returned microphone track`);
        else assert.ok(levels[frequency] > 0.08,
          `${frequency} Hz attempted playback must remain in default reference capture`);
      }
      assert.ok(levels[2200] > 0.03, 'Independent page/assistant audio must remain in the same tab recording');
      assert.ok(levels[2300] > 0.03, 'Page/assistant audio emitted only while the microphone is stopped must still be captured');
      assert.equal(await session.page.evaluate(() => pageAudio.context.state), 'running');
      await session.close();
      assert.equal(session.page.isClosed(), true);
      verified = true;
    } finally {
      await session.close();
      if (verified) await rm(outputDir, { recursive: true, force: true });
      else console.error(`Capture-input evidence retained at ${outputDir}`);
    }
  });
}

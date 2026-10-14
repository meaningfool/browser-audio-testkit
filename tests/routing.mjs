import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createVoiceBrowserSession } from '@meaningfool/browser-audio-testkit';
import { captureTarget, neutral, waitFor } from './helpers.mjs';

for (const listenLive of [false, true]) {
  await test(`native routing exists before navigation and persists after finish, listenLive=${listenLive}`, { timeout: 60000 }, async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'audio-routing-'));
    const session = await createVoiceBrowserSession({ origin: 'https://neutral.invalid', outputDir, listenLive });
    const recorder = await captureTarget(session);
    try {
      // Native disconnect(destination) throws when the edge does not exist. This
      // independent browser observation verifies routing, not physical host volume.
      const probe = () => recorder.evaluate(`(() => {
        try { source.disconnect(captureContext.destination); }
        catch (error) { if (error.name === 'InvalidAccessError') return false; throw error; }
        source.connect(captureContext.destination); return true;
      })()`);
      assert.equal(await probe(), listenLive, 'Factory must prepare listening before exposing the page');
      const tabs = () => session.context.serviceWorkers()[0].evaluate('chrome.tabCapture.getCapturedTabs()');
      const activeTabs = (await tabs()).filter(tab => tab.status === 'active');
      assert.equal(activeTabs.length, 1);
      const tabId = activeTabs[0].tabId;
      await neutral(session, `<!doctype html><body><script>
        window.audioReady = (async () => {
          const context = new AudioContext(); await context.resume();
          const oscillator = context.createOscillator(); oscillator.connect(context.destination); oscillator.start();
          return context.state;
        })();
      </script>`);
      assert.equal(await session.page.evaluate('audioReady'), 'running', 'Immediate first-navigation autoplay must run');
      assert.equal(await probe(), listenLive);
      await session.startRecording();
      await session.stopRecording();
      assert.equal(await probe(), listenLive, 'Finishing must retain listening policy');
      // Destroy the real capture document through the browser, without sending a
      // library-specific loss notification. Native tab state must suppress output.
      await recorder.cdp.send('Target.closeTarget', { targetId: recorder.target.targetId });
      await waitFor(async () => {
        if (session.page.isClosed()) return true;
        const owned = await session.context.serviceWorkers()[0].evaluate('chrome.tabs.query({})');
        return owned.some(tab => tab.id === tabId && tab.mutedInfo.muted);
      }, Boolean, 'Capture loss must close or natively mute the owned tab');
      await assert.rejects(session.readState(), /capture|closed|failed|lost/i);
      const releases = await Promise.allSettled([session.close(), session.close()]);
      assert.equal(releases[0].status, 'rejected');
      assert.equal(releases[1].status, 'rejected');
      assert.equal(releases[0].reason, releases[1].reason);
      assert.equal(session.page.isClosed(), true);
    } finally {
      await recorder.cdp.detach().catch(() => {});
      await session.close().catch(() => {});
      await rm(outputDir, { recursive: true, force: true });
    }
  });
}

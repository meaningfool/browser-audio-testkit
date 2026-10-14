import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createVoiceBrowserSession } from '@meaningfool/browser-audio-testkit';

for (const listenLive of [false, true]) {
  await test(`native capture output routing with listenLive=${listenLive}`, { timeout: 60000 }, async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'audio-routing-'));
    const session = await createVoiceBrowserSession({ origin: 'https://neutral.invalid', outputDir, listenLive });
    const cdp = await session.context.browser().newBrowserCDPSession();
    try {
      await session.context.route('https://neutral.invalid/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' }));
      await session.page.goto('https://neutral.invalid/');
      await session.startRecording();
      const { targetInfos } = await cdp.send('Target.getTargets');
      const target = targetInfos.find(target => target.type === 'background_page' && target.url.endsWith('/recorder.html'));
      assert.ok(target, 'Chromium must expose the actual capture document');
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: false });
      const result = new Promise((resolve, reject) => {
        cdp.on('Target.receivedMessageFromTarget', event => {
          if (event.sessionId !== sessionId) return;
          const message = JSON.parse(event.message);
          if (message.id !== 1) return;
          if (message.error || message.result.exceptionDetails) reject(new Error(JSON.stringify(message)));
          else resolve(message.result.result.value);
        });
      });
      // Native disconnect(destination) throws InvalidAccessError when that edge
      // does not exist. Probe the real output edge and restore it if present;
      // this reads browser routing independently of monitorConnected metadata.
      await cdp.send('Target.sendMessageToTarget', {
        sessionId,
        message: JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
          expression: `(() => {
            try { source.disconnect(captureContext.destination); }
            catch (error) { if (error.name === 'InvalidAccessError') return false; throw error; }
            source.connect(captureContext.destination);
            return true;
          })()`, returnByValue: true,
        } }),
      });
      assert.equal(await result, listenLive);
      const capturedTabs = await session.context.serviceWorkers()[0].evaluate('chrome.tabCapture.getCapturedTabs()');
      assert.equal(capturedTabs.filter(tab => tab.status === 'active').length, 1, 'Chromium must actually divert one captured tab');
    } finally {
      await cdp.detach();
      await session.close();
      await rm(outputDir, { recursive: true, force: true });
    }
  });
}

import { test as base, expect } from "@playwright/test";
import { createSession } from "./session.js";
import type { VoiceBrowserOptions, VoiceBrowserSession } from "./types.js";

export { expect };
export type VoiceBrowserFixtureOptions = Omit<VoiceBrowserOptions, "outputDir">;
export interface VoiceBrowserFixtures {
  voiceBrowser: VoiceBrowserSession;
  voiceBrowserOptions: VoiceBrowserFixtureOptions;
}

type Acquired = { session: VoiceBrowserSession; releaseOwned: boolean };
type Acquisition = { _voiceBrowserSession: Acquired };

// Separate standard fixture slots prevent acquisition from consuming the
// release budget: Playwright otherwise shares a fixture's setup/teardown slot.
export const test = base.extend<VoiceBrowserFixtures & Acquisition>({
  voiceBrowserOptions: [async ({}, use) => {
    throw new Error("Configure voiceBrowserOptions with the application's HTTP(S) origin");
  }, { option: true }],
  _voiceBrowserSession: [async ({ voiceBrowserOptions }, use, testInfo) => {
    const session = await createSession({
      ...voiceBrowserOptions,
      outputDir: testInfo.outputPath("browser-audio"),
    }, 38_000);
    const acquired = { session, releaseOwned: false };
    try {
      await use(acquired);
    } finally {
      // Fallback for a dependent fixture failing before voiceBrowser takes ownership.
      if (!acquired.releaseOwned) await session.close();
    }
  }, { timeout: 60_000 }],
  voiceBrowser: [async ({ _voiceBrowserSession }, use) => {
    _voiceBrowserSession.releaseOwned = true;
    try {
      await use(_voiceBrowserSession.session);
    } finally {
      // Let Playwright append cleanup errors alongside the original test error.
      await _voiceBrowserSession.session.close();
    }
  }, { timeout: 60_000 }],
  context: async ({ voiceBrowser }, use) => {
    await use(voiceBrowser.context);
  },
  page: async ({ voiceBrowser }, use) => {
    await use(voiceBrowser.page);
  },
});

import { createRequire } from "node:module";
import type { chromium as Chromium } from "playwright";

const require = createRequire(import.meta.url);

// Playwright 1.63's test runner mutates its shared client with launch defaults,
// context options and artifact hooks. A separate client is required even for
// persistent contexts. Keep this private compatibility seam version-pinned;
// the packed consumer suite verifies isolation and ordinary Page/Context use.
const { inprocess } = require("playwright-core/lib/coreBundle") as {
  inprocess: { createInProcessPlaywright(): { chromium: typeof Chromium } };
};
export const { chromium } = inprocess.createInProcessPlaywright();

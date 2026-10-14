import { test, expect } from "@meaningfool/browser-audio-testkit/playwright";
import { neutral } from "./helpers.mjs";
test.use({ voiceBrowserOptions: { origin: "https://neutral.invalid" } });

test("explicit stock browser remains separate", async ({ browser, context, voiceBrowser }) => {
  expect(context.browser()).not.toBe(browser);
  expect(browser.contexts()).toHaveLength(0);
  const cdp = await browser.newBrowserCDPSession();
  expect((await cdp.send("Browser.getBrowserCommandLine")).arguments).toContain("--audio-testkit-stock-only");
  await cdp.detach();
  await neutral(voiceBrowser);
});

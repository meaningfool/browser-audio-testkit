import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

test("installed fixture preserves journey, failure evidence and isolated ownership", { timeout: 240000 }, async () => {
  await writeFile("playwright.config.mjs", `export default {
    testMatch: "fixture*.spec.mjs", fullyParallel: true, workers: 2, retries: 1,
    timeout: 15000, outputDir: "fixture-results", preserveOutput: "always",
    reporter: [["json", { outputFile: process.env.AUDIO_TESTKIT_REPORT || "fixture-report.json" }]],
    use: {
      baseURL: "https://stock.invalid", userAgent: "stock-runner",
      locale: "fr-FR", viewport: { width: 111, height: 222 },
      storageState: { cookies: [{ name: "stock", value: "stock", domain: "neutral.invalid", path: "/", expires: -1, httpOnly: false, secure: true, sameSite: "Lax" }], origins: [] },
      launchOptions: { args: ["--audio-testkit-stock-only", "--enable-automation"] },
      trace: "on", video: "on", actionTimeout: 1,
    },
  };`);
  const child = spawnSync(process.execPath, ["node_modules/@playwright/test/cli.js", "test", "fixture.spec.mjs"], {
    encoding: "utf8", timeout: 240000,
  });
  assert.equal(child.status, 1, child.stdout + child.stderr);
  const report = JSON.parse(await readFile("fixture-report.json", "utf8"));
  const specs = suite => [...(suite.specs ?? []), ...(suite.suites ?? []).flatMap(specs)];
  const cases = report.suites.flatMap(specs);
  function results(title) {
    const entry = cases.find(spec => spec.title === title);
    assert.ok(entry, `missing ${title}: ${child.stdout} ${child.stderr}`);
    return entry.tests.flatMap(test => test.results);
  }
  for (const title of ["ordinary journey and option isolation", "parallel artifact 1", "parallel artifact 2"])
    assert.equal(results(title)[0].status, "passed", JSON.stringify(results(title)));
  assert.deepEqual(results("retry gets fresh artifacts").map(result => result.status), ["failed", "passed"]);
  assert.equal(results("short body timeout retains cleanup allowance")[0].status, "timedOut");
  const bodyFailure = results("body failure flushes active recording")[0];
  assert.equal(bodyFailure.status, "failed");
  assert.ok(JSON.stringify(bodyFailure.errors).includes("original-body-failure"));
  const cleanup = results("original failure and cleanup failure both visible")[0];
  assert.ok(JSON.stringify(cleanup.errors).includes("original-before-cleanup-failure"));
  assert.ok(JSON.stringify(cleanup.errors).includes("Voice browser cleanup failed"));
  const directories = (await readdir("fixture-results")).filter(name => !name.startsWith("."));
  const outputs = [];
  for (const directory of directories) {
    const path = join("fixture-results", directory);
    if (!(await stat(path)).isDirectory()) continue;
    const observed = JSON.parse(await readFile(join(path, "observed.json"), "utf8"));
    assert.equal(observed.outputDir, resolve(path, "browser-audio"));
    outputs.push(observed.outputDir);
    assert.equal(await readFile(join(path, "released"), "utf8"), "closed");
    assert.equal(await readFile(join(path, "context-released"), "utf8"), "closed");
    assert.equal(await readFile(join(path, "browser-released"), "utf8"), "closed");
    const names = await readdir(path);
    assert.ok(!names.some(name => name.endsWith(".webm")), "stock video must not record the owned page");
    const traceEntries = execFileSync("unzip", ["-Z1", join(path, "trace.zip")], { encoding: "utf8" });
    assert.ok(!traceEntries.includes("-trace.trace"), "stock trace must not capture the owned context");
    if (["short body timeout retains cleanup allowance", "body failure flushes active recording", "retry gets fresh artifacts", "parallel artifact 1", "parallel artifact 2"].includes(observed.title)) {
      const metadata = JSON.parse(await readFile(join(observed.outputDir, "capture.json"), "utf8"));
      assert.equal(metadata.state, "finished");
      assert.ok(metadata.bytes > 0);
      assert.equal((await stat(metadata.capturePath)).size, metadata.bytes);
      execFileSync("ffmpeg", ["-v", "error", "-i", metadata.capturePath, "-f", "null", "-"], { timeout: 30000 });
    }
  }
  assert.equal(new Set(outputs).size, outputs.length, "parallel/retry artifact directories must be unique");
  assert.ok(outputs.length >= 11, `missing completed attempts: ${outputs.length}`);
  const stock = spawnSync(process.execPath, ["node_modules/@playwright/test/cli.js", "test", "fixture-stock.spec.mjs", "--workers=1", "--retries=0", "--output=stock-results"], {
    encoding: "utf8", timeout: 90000,
    env: { ...process.env, AUDIO_TESTKIT_REPORT: "stock-report.json" },
  });
  assert.equal(stock.status, 0, stock.stdout + stock.stderr + await readFile("stock-report.json", "utf8"));
});

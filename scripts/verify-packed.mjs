import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, cp, rm, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
let succeeded = false;
const consumer = await mkdtemp(join(tmpdir(), "browser-audio-consumer-"));
try {
  const fixtureOnly = process.argv.includes("--fixture-only");
  let artifact = process.argv.slice(2).find(value => !value.startsWith("--"));
  if (artifact && !/^https?:\/\//.test(artifact)) artifact = resolve(artifact);
  if (!artifact) {
    execFileSync("pnpm", ["pack", "--pack-destination", consumer], { stdio: "inherit" });
    const archive = (await readdir(consumer)).find(name => name.endsWith(".tgz"));
    if (!archive) throw new Error("Packed artifact missing");
    artifact = join(consumer, archive);
  }
  await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", artifact, "typescript@5.9.3", "@types/node@26.0.0"], { cwd: consumer, stdio: "inherit" });
  const lock = JSON.parse(await readFile(join(consumer, "package-lock.json"), "utf8"));
  const installed = lock.packages["node_modules/@meaningfool/browser-audio-testkit"];
  if (!installed?.integrity?.startsWith("sha512-"))
    throw new Error("Installed distribution is missing lockfile integrity");
  if (/^https?:\/\//.test(artifact) && installed.resolved !== artifact)
    throw new Error("Consumer did not install the exact requested release URL");
  await cp("tests/types.mts", join(consumer, "types.mts"));
  execFileSync(process.execPath, ["node_modules/typescript/bin/tsc", "--noEmit", "--strict", "--module", "NodeNext", "--target", "ES2022", "types.mts"], { cwd: consumer, stdio: "inherit", timeout: 30000 });
  await cp("tests/fixture.mjs", join(consumer, "fixture.mjs"));
  await cp("tests/fixture.spec.mjs", join(consumer, "fixture.spec.mjs"));
  await cp("tests/fixture-stock.spec.mjs", join(consumer, "fixture-stock.spec.mjs"));
  await cp("tests/helpers.mjs", join(consumer, "helpers.mjs"));
  await cp("tests/lifecycle.mjs", join(consumer, "lifecycle.mjs"));
  await cp("tests/consumer.mjs", join(consumer, "consumer.mjs"));
  await cp("tests/capture-input.mjs", join(consumer, "capture-input.mjs"));
  await cp("tests/failure.mjs", join(consumer, "failure.mjs"));
  await cp("tests/routing.mjs", join(consumer, "routing.mjs"));
  await cp("tests/setup-failure.mjs", join(consumer, "setup-failure.mjs"));
  if (!fixtureOnly) {
    execFileSync(process.execPath, ["--test", "setup-failure.mjs"], { cwd: consumer, stdio: "inherit", timeout: 90000, env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: join(consumer, "absent") } });
    execFileSync(process.execPath, ["--test", "consumer.mjs"], { cwd: consumer, stdio: "inherit", timeout: 90000 });
    execFileSync(process.execPath, ["--test", "capture-input.mjs"], { cwd: consumer, stdio: "inherit", timeout: 180000 });
    execFileSync(process.execPath, ["--test", "lifecycle.mjs"], { cwd: consumer, stdio: "inherit", timeout: 180000 });
    execFileSync(process.execPath, ["--test", "routing.mjs"], { cwd: consumer, stdio: "inherit", timeout: 180000 });
    execFileSync(process.execPath, ["--test", "failure.mjs"], { cwd: consumer, stdio: "inherit", timeout: 300000 });
  }
  execFileSync(process.execPath, ["--test", "fixture.mjs"], { cwd: consumer, stdio: "inherit", timeout: 300000 });
  succeeded = true;
} finally {
  if (succeeded) await rm(consumer, { recursive: true, force: true });
  else console.error(`Failed consumer evidence retained at ${consumer}`);
}

import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, cp, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const consumer = await mkdtemp(join(tmpdir(), "browser-audio-consumer-"));
try {
  execFileSync("pnpm", ["pack", "--pack-destination", consumer], { stdio: "inherit" });
  const archive = (await readdir(consumer)).find(name => name.endsWith(".tgz"));
  if (!archive) throw new Error("Packed artifact missing");
  await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", join(consumer, archive), "typescript@5.9.3", "@types/node@26.0.0"], { cwd: consumer, stdio: "inherit" });
  await cp("tests/types.mts", join(consumer, "types.mts"));
  execFileSync(process.execPath, ["node_modules/typescript/bin/tsc", "--noEmit", "--strict", "--module", "NodeNext", "--target", "ES2022", "types.mts"], { cwd: consumer, stdio: "inherit", timeout: 30000 });
  await cp("tests/consumer.mjs", join(consumer, "consumer.mjs"));
  await cp("tests/failure.mjs", join(consumer, "failure.mjs"));
  await cp("tests/routing.mjs", join(consumer, "routing.mjs"));
  await cp("tests/setup-failure.mjs", join(consumer, "setup-failure.mjs"));
  execFileSync(process.execPath, ["--test", "setup-failure.mjs"], { cwd: consumer, stdio: "inherit", timeout: 90000, env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: join(consumer, "absent") } });
  execFileSync(process.execPath, ["--test", "consumer.mjs"], { cwd: consumer, stdio: "inherit", timeout: 90000 });
  execFileSync(process.execPath, ["--test", "routing.mjs"], { cwd: consumer, stdio: "inherit", timeout: 90000 });
  execFileSync(process.execPath, ["--test", "failure.mjs"], { cwd: consumer, stdio: "inherit", timeout: 90000 });
} finally {
  await rm(consumer, { recursive: true, force: true });
}

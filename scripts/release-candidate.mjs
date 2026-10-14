import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Run from the reviewed checkout; the ignored release directory is the output.
execFileSync("pnpm", ["check"], { stdio: "inherit" });
execFileSync("pnpm", ["test"], { stdio: "inherit" });
await mkdir("release", { recursive: true });
execFileSync("pnpm", ["pack", "--pack-destination", "release"], { stdio: "inherit" });
const { version } = JSON.parse(await readFile("package.json", "utf8"));
const filename = `meaningfool-browser-audio-testkit-${version}.tgz`;
const digest = data => createHash("sha256").update(data).digest("hex");
const first = digest(await readFile(join("release", filename)));
const secondDirectory = await mkdtemp(join(tmpdir(), "browser-audio-repeat-pack-"));
try {
  execFileSync("pnpm", ["pack", "--pack-destination", secondDirectory], { stdio: "inherit" });
  assert.equal(digest(await readFile(join(secondDirectory, filename))), first,
    "Repeated builds must produce identical release tarballs");
} finally {
  await rm(secondDirectory, { recursive: true, force: true });
}
await writeFile("release/SHA256SUMS", `${first}  ${filename}\n`);
console.log(`Validated release candidate: release/${filename} (SHA-256 ${first})`);

import { execFileSync } from "node:child_process";
import { cp, rm } from "node:fs/promises";
await rm("dist", { recursive: true, force: true });
execFileSync("pnpm", ["exec", "tsc"], { stdio: "inherit" });
await cp("src/page-media.js", "dist/page-media.js");
await cp("src/extension", "dist/extension", { recursive: true });

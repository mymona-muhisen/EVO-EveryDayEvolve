import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const artifactDir = dirname(dirname(fileURLToPath(import.meta.url)));
const smoke = process.argv[2] === "smoke";
const daily = process.argv[2] === "daily";
const display = process.argv[2] === "display";
const tempDir = await mkdtemp(join(artifactDir, ".ai-test-"));

try {
  const output = join(tempDir, "run.mjs");
  await build({
    entryPoints: [join(artifactDir, smoke ? "src/lib/geminiSmoke.ts" : daily ? "src/lib/dailyExecution.test.ts" : display ? "../habit-journey/test/daily-display.test.mjs" : "src/lib/aiMessages.test.ts")],
    outfile: output,
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    logLevel: "silent",
  });
  const result = spawnSync(process.execPath, smoke ? [output] : ["--test", output], {
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
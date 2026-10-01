import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const apiDir = dirname(dirname(fileURLToPath(import.meta.url)));
const tempDir = await mkdtemp(join(apiDir, ".time-pure-test-"));
try {
  const output = join(tempDir, "trackingTimer.test.mjs");
  await build({
    entryPoints: [join(apiDir, "src/lib/trackingTimer.test.ts")],
    outfile: output,
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  const result = spawnSync(process.execPath, ["--test", output, join(apiDir, "test/time-tracking-api.mjs")], {
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
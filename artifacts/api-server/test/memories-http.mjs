import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The feature-10 PostgreSQL audit harness already mounts the production memory
// router against an isolated schema and a network-only storage adapter. The
// social privacy suite adds HTTP coverage for private-photo ACL behavior.
const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runs = [
  [
    "--test",
    "--test-name-pattern=memory|memories",
    "./test/reward-atomicity.mjs",
  ],
  ["--test", "./test/social-privacy.mjs"],
];
let exitCode = 0;
for (const args of runs) {
  const result = spawnSync(process.execPath, args, {
    cwd: apiDir,
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.signal) {
    console.error(`Memory API test process terminated by ${result.signal}`);
    exitCode = 1;
  } else if (result.status !== 0) {
    exitCode = result.status ?? 1;
  }
}

process.exitCode = exitCode;
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const temp = await mkdtemp(join(root, ".coach-test-"));
try {
  const file = join(temp, "day-coach.test.mjs");
  await build({ entryPoints: [join(root, "src/lib/dayCoach.test.ts")], outfile: file,
    bundle: true, packages: "external", platform: "node", format: "esm",
    plugins: [{
      name: "database-free-coach-tests",
      setup(b) {
        b.onResolve({ filter: /^@workspace\/db$/ }, () => ({ path: "db-stub", namespace: "coach-test" }));
        b.onLoad({ filter: /.*/, namespace: "coach-test" }, () => ({
          contents: "export const db = {}; export const timeEntriesTable = {};",
        }));
      },
    }],
  });
  const result = spawnSync(process.execPath, ["--test", file], { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} finally { await rm(temp, { recursive: true, force: true }); }
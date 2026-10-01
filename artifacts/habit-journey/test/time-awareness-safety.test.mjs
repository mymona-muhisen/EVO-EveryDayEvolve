import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const sourceFile = join(dirname(dirname(fileURLToPath(import.meta.url))), "src/pages/time-awareness.tsx");
const source = await readFile(sourceFile, "utf8");

test("time tracking has no browser alerts, permission prompts, due UI, or alarm copy", () => {
  assert.doesNotMatch(source, /\bNotification\b|requestPermission|AudioContext|\.vibrate\(/);
  assert.doesNotMatch(source, /\bdue\b|\bremaining\b|حان وقت|تذكير|جرس|تنبيه/);
  assert.match(source, /data-testid="text-active-elapsed"/);
  assert.match(source, /data-testid="text-interval-progress"/);
});

test("activity chooser is gated behind an explicit manual action and unknown remains selectable", () => {
  assert.match(source, /data-testid="button-open-checkin"[^]*setCheckinOpen\(true\)/);
  assert.match(source, /\{!checkinOpen\?[\s\S]*?data-testid="panel-checkin-chooser"/);
  assert.match(source, /key:'unknown',name:'لا أتذكر'/);
  assert.match(source, /setMinutes\(current\?\.intervalMinutes\?\?interval\)/);
});
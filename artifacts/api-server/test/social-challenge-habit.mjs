import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const apiDir = dirname(dirname(fileURLToPath(import.meta.url)));
const dbStub = `
export const habitDaysTable = {};
export const habitPlanRevisionsTable = {};
export const habitsTable = { $inferInsert: { category: "category" } };
export const journeyRewardsTable = {};
export const memoriesTable = {};
export const socialActivityEventsTable = {};
export const socialBlocksTable = {};
export const socialChallengeMembersTable = {};
export const socialChallengesTable = {};
export const socialFriendRequestsTable = {};
export const socialFriendshipsTable = {};
export const socialNotificationsTable = {};
export const socialShareRecipientsTable = {};
export const socialSharesTable = {};
export const usersTable = {};
`;
const journeyStub = `
export const HABIT_JOURNEY_LENGTH = 22;
export const makeJourneyDays = () => [];
export const resolveExecutionType = (_unit, goalType, executionType) =>
  executionType ?? (goalType === "quit" ? "limit" : "count");
export const snapshotPlan = value => value;
`;
const commonStub = `
export class SocialHttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
`;
const bundle = await build({
  entryPoints: [resolve(apiDir, "src/services/challengeHabitService.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  plugins: [{
    name: "isolated-social-test-dependencies",
    setup(buildApi) {
      buildApi.onResolve({ filter: /^@workspace\/db$/ }, () => ({ path: "db", namespace: "isolated" }));
      buildApi.onLoad({ filter: /^db$/, namespace: "isolated" }, () => ({ contents: dbStub, loader: "js" }));
      buildApi.onResolve({ filter: /^\.\.\/lib\/habitJourney$/ }, () => ({ path: "journey", namespace: "isolated" }));
      buildApi.onLoad({ filter: /^journey$/, namespace: "isolated" }, () => ({ contents: journeyStub, loader: "js" }));
      buildApi.onResolve({ filter: /^\.\.\/lib\/dates$/ }, () => ({ path: "dates", namespace: "isolated" }));
      buildApi.onLoad({ filter: /^dates$/, namespace: "isolated" }, () => ({
        contents: "export const todayInTimezone = () => '2030-01-01';",
        loader: "js",
      }));
      buildApi.onResolve({ filter: /^\.\.\/services\/social-common$/ }, () => ({ path: "common", namespace: "isolated" }));
      buildApi.onLoad({ filter: /^common$/, namespace: "isolated" }, () => ({ contents: commonStub, loader: "js" }));
    },
  }],
});
const loaded = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const { validateChallengeHabitPlan } = loaded;
const buildTemplate = {
  title: "Read",
  emoji: "📖",
  category: "learning",
  cadence: "daily",
  customDays: null,
  unit: "pages",
  executionType: "count",
  goalType: "build",
  difficulty: "easy",
  suggestedTargetValue: 10,
  suggestedMinimumValue: 3,
};

test("challenge plan copies only safe defaults and permits valid personalization", () => {
  assert.deepEqual(validateChallengeHabitPlan(buildTemplate, {
    targetValue: 12,
    minimumValue: 4,
    cadence: "weekdays",
  }), {
    targetValue: 12,
    minimumValue: 4,
    cadence: "weekdays",
    customDays: null,
    executionType: "count",
    successLimitValue: null,
  });
});

test("build challenges reject zero targets and minimums above targets", () => {
  assert.throws(() => validateChallengeHabitPlan(buildTemplate, { targetValue: 0 }), {
    status: 400,
  });
  assert.throws(() => validateChallengeHabitPlan(buildTemplate, {
    targetValue: 2,
    minimumValue: 3,
  }), { status: 400 });
});

test("custom cadence requires a unique valid weekday selection", () => {
  assert.throws(() => validateChallengeHabitPlan(buildTemplate, {
    cadence: "custom_days",
  }), { status: 400 });
  assert.throws(() => validateChallengeHabitPlan(buildTemplate, {
    cadence: "custom_days",
    customDays: [1, 1],
  }), { status: 400 });
  assert.deepEqual(validateChallengeHabitPlan(buildTemplate, {
    cadence: "custom_days",
    customDays: [1, 3, 5],
  }).customDays, [1, 3, 5]);
});

test("quit challenge plans require limit execution and maintain valid upper limits", () => {
  const quitTemplate = {
    ...buildTemplate,
    goalType: "quit",
    executionType: "limit",
    suggestedTargetValue: 5,
    suggestedMinimumValue: 2,
  };
  assert.equal(validateChallengeHabitPlan(quitTemplate, {}).successLimitValue, 5);
  assert.throws(() => validateChallengeHabitPlan({
    ...quitTemplate,
    executionType: "count",
  }, {}), { status: 400 });
  assert.throws(() => validateChallengeHabitPlan(quitTemplate, {
    targetValue: 4,
    minimumValue: 5,
  }), { status: 400 });
});
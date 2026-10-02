# EVO day coach

## What changed

- Shared server analysis: `artifacts/api-server/src/lib/dayCoach.ts`, `coachHistory.ts`, `trackedDay.ts`, and `trackedAnalysisCache.ts`.
- Confirmation-based habit recommendations and creation validation: `src/lib/aiRules.ts` and `src/routes/habits.ts` in the API server.
- RTL interfaces: `components/day-insights.tsx`, `components/habit-wizard.tsx`, `components/habit-plan-form.tsx`, `components/dashboard/dashboard-secondary.tsx`, and `pages/{home,time-awareness,habits}.tsx` in the web app.
- Contract and generated clients: `lib/api-spec/openapi.yaml`, `lib/api-client-react/src/generated/`, `lib/api-zod/src/generated/`.
- Habit schema and additive migration: `lib/db/src/schema/habits.ts`, `lib/db/migrations/0010_day_coach_habit_intention.sql`.

## Data and API

Existing APIs and habit models are reused:

- `GET /api/time-tracking/analysis?date=YYYY-MM-DD`: observation, pattern, small recovery budget, replacement reasons, three insight slots, recommendation, habit adjustment, supported replacement period, tomorrow suggestion, and source.
- `POST /api/habits`: optional original intention, desired target/unit, recommended starting target, and recovery origin. The server verifies recovery category/budget against this owner's actual records before saving.
- `GET /api/habits/:id/adaptation` and `PATCH /api/habits/:id`: existing proposal/confirmation flow. Today's snapshots and recorded days remain unchanged.

Nullable columns preserve unknown legacy intentions: `original_goal`, `desired_target`, `desired_unit`, `recommended_starting_target`, `origin`. Development migration was applied; existing habit data was not backfilled or rewritten.

## AI and fallback

The existing Gemini adapter receives a small structured summary, not database rows, credentials, raw activity notes, or account information. A supportive Arabic system prompt limits its output to an allowed headline, a supported action index, and an allowed encouragement. Strict JSON validation prevents provider-generated numbers or unsupported conclusions from entering the experience.

Application calculations supply all factual text and numbers. Malformed JSON, unsupported choices, provider errors, and the three-second timeout return the same deterministic Arabic analysis. Insufficient records do not trigger a provider call. Failed-provider results are cached briefly before another attempt.

Recovery suggestions are 10–20 minutes, only from sufficiently recorded optional activities. Manual records support duration/category totals but never establish a time-of-day pattern. Suggested periods are explicitly replacements within observed activity, not proof of free time or measured concentration.

Habit observations use the last seven calendar dates, exclude known rest days and future obligations, and separate current-plan evidence from old revisions. Repeated difficulty and low completion can suggest reductions; consistent completion can suggest gradual increases. Forgotten, busy-day, and motivation reflections support cue/minimum-step alternatives. Nothing is changed automatically.

## Try the complete flow

1. Sign in and open **وقتي**.
2. Record categorized intervals and finish the tracking session. Meaningful interval analysis needs at least three confirmed intervals and 60 recorded minutes; a recovery opportunity also requires sufficient social-media, gaming, or entertainment time.
3. Review **ماذا يقول يومك؟** and the small reduction opportunity.
4. Accept, choose a replacement or enter a custom activity, and open the existing habit wizard.
5. Compare **هدفك** with the suggested starting target. Keep your goal, choose the suggestion, or edit it; review the editable cue.
6. Confirm creation. Follow the new habit link and verify it on the dashboard after reload.
7. With sufficient history, review adaptations on the habit page. Accept, edit, or dismiss; the original intention stays visible.

No public sample-data or authentication bypass was added.

## Checks

```sh
pnpm run typecheck
pnpm --filter @workspace/api-server run test:day-coach
pnpm --filter @workspace/api-server run test:ai
pnpm --filter @workspace/api-server run test:time
pnpm --filter @workspace/api-server run test:daily
pnpm --filter @workspace/api-server run test:dashboard
```

The coaching tests include bounded budgets, local interval allocation, manual/unknown history, rest days, current revisions, high/low completion, relapse cues, provider failure, malicious JSON, and private-field exclusion.

Verification completed: workspace type checks, production frontend build, and 47 coaching/AI/time/daily/dashboard tests passed. An authenticated browser pass verified the complete recovery-to-habit journey, provenance, original-versus-active targets, editable cue, explicit save, dashboard reload, and invalid-budget rejection. Test-only accounts and data were removed.

## Boundaries

- Coaching does not diagnose intent, mood, or concentration. A single day's period is not called a recurring routine.
- New habits use a conservative starting policy, not a claim that unrecorded time is available.
- Temporary lighter execution uses the existing minimum/busy-day versions. There is no automatic “reduce for three days then restore the target” scheduler.
- Legacy goals remain unknown rather than reconstructed from targets that may already have changed.
- Schema changes must accompany publishing the updated app; no production data was modified here.
- The browser pass found slight horizontal overflow on the narrow mobile Time page. Primary content and actions remained readable and the flow completed; this responsive-layout issue remains.
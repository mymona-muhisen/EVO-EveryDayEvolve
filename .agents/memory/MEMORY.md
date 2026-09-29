# Memory Index

- [Vite stale cache causes phantom dev errors](vite-stale-cache.md) — clear `node_modules/.vite`/`.vite-temp` + restart before suspecting the package itself.
- [Orval Zod query-param dates aren't coerced](orval-zod-date-query-params.md) — date-typed query params generate plain `z.date()`, not `.coerce.date()`; pre-convert strings before `.safeParse()`.
- [E2E-testing time-gated game state](e2e-testing-time-gated-state.md) — Playwright can't wait real calendar days; seed streak/date fields directly via [DB] steps to reach those states.
- [Habit Journey: relapse-recovery suggestion is display-only](habit-journey-relapse-recovery-gap.md) — backend computes a lower suggested target but the frontend never applies it to the habit.

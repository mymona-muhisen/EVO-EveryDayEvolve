# Memory Index

- [Vite stale cache causes phantom dev errors](vite-stale-cache.md) — clear `node_modules/.vite`/`.vite-temp` + restart before suspecting the package itself.
- [Orval Zod query-param dates aren't coerced](orval-zod-date-query-params.md) — date-typed query params generate plain `z.date()`, not `.coerce.date()`; pre-convert strings before `.safeParse()`.
- [E2E-testing time-gated game state](e2e-testing-time-gated-state.md) — Playwright can't wait real calendar days; seed streak/date fields directly via [DB] steps to reach those states.
- [Gemini model listings can include retired generators](gemini-model-availability.md) — a listed model may return 404 on generation; probe generation before trusting listings.

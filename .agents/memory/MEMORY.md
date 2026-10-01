# Memory Index

- [Vite stale cache causes phantom dev errors](vite-stale-cache.md) — clear `node_modules/.vite`/`.vite-temp` + restart before suspecting the package itself.
- [Orval Zod date boundaries](orval-zod-date-query-params.md) — path/query dates need explicit coercion; response date parsing may serialize as ISO timestamps rather than YYYY-MM-DD.
- [E2E-testing time-gated game state](e2e-testing-time-gated-state.md) — Playwright can't wait real calendar days; seed streak/date fields directly via [DB] steps to reach those states.
- [Gemini model listings can include retired generators](gemini-model-availability.md) — a listed model may return 404 on generation; probe generation before trusting listings.
- [Isolated API test bundling](isolated-api-test-bundling.md) — bundle workspace libraries for Node test runners; externalizing them can expose extensionless ESM imports.
- [Time awareness data boundaries](time-awareness-boundaries.md) — count only explicitly categorized intervals; never fill missed check-ins or let generated prose invent numeric conclusions.
- [Historical reward preservation](historical-reward-policy.md) — ambiguous old reward markers are not evidence of nonpayment; atomicity fixes must not retroactively grant rewards.
- [Adaptive habit boundaries](adaptive-habit-policy.md) — 22 calendar dates include rest days; today's plan stays fixed, and accepted adjustments need fresh numeric evidence.

# Memory Index

- [Vite stale cache causes phantom dev errors](vite-stale-cache.md) — clear `node_modules/.vite`/`.vite-temp` + restart before suspecting the package itself.
- [Orval Zod date boundaries](orval-zod-date-query-params.md) — path/query dates need explicit coercion; response date parsing may serialize as ISO timestamps rather than YYYY-MM-DD.
- [Time-gated E2E fixtures](e2e-testing-time-gated-state.md) — seed calendar and immutable day plans coherently; start-date-only shifts create false progress defects.
- [Gemini model listings can include retired generators](gemini-model-availability.md) — a listed model may return 404 on generation; probe generation before trusting listings.
- [Isolated API tests](isolated-api-test-bundling.md) — bundle workspace libraries and include every imported route's database read dependencies in isolated fixtures.
- [Time awareness data boundaries](time-awareness-boundaries.md) — count only explicitly categorized intervals; never fill missed check-ins or let generated prose invent numeric conclusions.
- [Historical reward preservation](historical-reward-policy.md) — ambiguous old reward markers are not evidence of nonpayment; atomicity fixes must not retroactively grant rewards.
- [Adaptive habit boundaries](adaptive-habit-policy.md) — 22 calendar dates include rest days; today's plan stays fixed, and accepted adjustments need fresh numeric evidence.
- [Daily habit boundaries](daily-habit-boundaries.md) — timer time is not activity proof; known legacy schedules differ from unknown history; consistency recovery is separate from paid repair.
- [Journey reward boundaries](journey-reward-boundaries.md) — valid final scheduled success, durable unlock gates across unlink/delete, and explicitly partial historical earnings.
- [Journey map verification](journey-map-verification.md) — measure nodes, characters, and action hit targets on first entry/reload at both map ends, including fixed navigation.
- [Reference catalog publishing](reference-catalog-publishing.md) — schema publishing does not copy migration seed rows; seed reference catalogs idempotently without changing existing prices or ownership.
- [Private upload ownership](private-upload-ownership.md) — knowing an object path never permits adoption; enforce ownership/provenance across every ACL-writing endpoint.

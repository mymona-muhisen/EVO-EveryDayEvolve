# Memory Index

- [Vite stale cache causes phantom dev errors](vite-stale-cache.md) — clear `node_modules/.vite`/`.vite-temp` + restart before suspecting the package itself.
- [Orval Zod query-param dates aren't coerced](orval-zod-date-query-params.md) — date-typed query params generate plain `z.date()`, not `.coerce.date()`; pre-convert strings before `.safeParse()`.

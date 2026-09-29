---
name: Orval-generated Zod query-param schemas don't coerce date strings
description: OpenAPI query params typed as string/format-date generate Zod schemas using plain z.date() (not .coerce.date()), so raw query strings fail validation unless pre-converted.
---

In this workspace's OpenAPI → Orval → Zod codegen pipeline, request-body date fields get `z.coerce.date()`, but **query-param** date fields generate plain `z.date()`. Since query params always arrive as strings, `.safeParse()` on the raw query object fails validation for any query schema with a date-typed field, even though the field name and type look correct in the generated schema.

**Why:** Orval's Zod generator treats query and body params differently for date coercion; this is a generator quirk, not a spec-authoring mistake. It affects any query schema with a date or date-range filter (e.g. `from`/`to`, `date`).

**How to apply:** Before calling `.safeParse()` on a query-params schema that includes date fields, pre-convert those specific string fields to `Date` objects yourself (see the `coerceQueryDates()` helper in `artifacts/api-server/src/lib/dates.ts`). When adding a new date/date-range query filter to the OpenAPI spec, check the generated query schema for `z.date()` (vs `.coerce.date()`) and wire it through the same helper if needed.

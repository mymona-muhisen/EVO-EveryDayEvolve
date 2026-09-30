---
name: Orval-generated Zod date boundaries
description: Request path/query dates need explicit coercion; response date parsing can turn calendar dates into ISO timestamps.
---

In this workspace's OpenAPI → Orval → Zod codegen pipeline, request-body date fields get `z.coerce.date()`, but **query-param** date fields generate plain `z.date()`. Since query params always arrive as strings, `.safeParse()` on the raw query object fails validation for any query schema with a date-typed field, even though the field name and type look correct in the generated schema.

**Why:** Orval's Zod generator treats query and body params differently for date coercion; this is a generator quirk, not a spec-authoring mistake. It affects any query schema with a date or date-range filter (e.g. `from`/`to`, `date`).

**How to apply:** Before calling `.safeParse()` on query or path params that include date fields, pre-convert those specific string fields to `Date` objects. Check generated params schemas after codegen.

Response schemas for `format: date` can also use coercion, turning a `YYYY-MM-DD` string into a JavaScript Date. Passing that parsed object to Express JSON serialization emits a full ISO timestamp (`YYYY-MM-DDT00:00:00.000Z`). **Why:** a browser comparing it directly with a local `YYYY-MM-DD` will miss the same calendar day, and date inputs reject timestamps. **How to apply:** Normalize calendar-date API values to their first 10 characters before comparing or putting them in `<input type="date">`. For "today", prefer the server's date in the user's saved timezone over browser clock assumptions, especially around midnight or when browser/test clocks differ.

---
name: Reference catalog publishing
description: Ensure reference catalog data exists after managed schema publishing without rewriting purchased identities or edited prices.
---

Reference catalogs need idempotent application seeding, independent of the development SQL migration that initially populates them. Never rely on migration INSERT statements alone to make a managed published database usable.

**Why:** Managed publishing applies schema differences, not the development migration's seed rows. A newly created catalog table can therefore exist but be empty after publishing. Reference data is not a reason to add startup DDL or a custom production migration runner.

**How to apply:** Seed small reference catalogs through the normal startup data-seeding hook before serving requests. Preserve stable purchased identities and existing prices with conflict-safe inserts; avoid updates or deletions that rewrite user-owned items. Keep schema migrations separate.
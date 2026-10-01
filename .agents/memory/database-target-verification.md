---
name: Database target verification
description: Verify migration targets through explicit platform environment selection.
---

Do not decide whether a SQL target is development solely from the app process's runtime environment flag or database name.

**Why:** In this workspace a shell runtime flag reported production while the platform's explicit development SQL target was available. This caused an unnecessary refusal to apply a development-only additive migration.

**How to apply:** For the managed database, use the platform SQL callback with an explicit development environment for development schema work. Never override runtime-managed connection variables or infer that a shell connection is safe from its database name. Production remains read-only unless the supported Publish flow is explicitly requested.
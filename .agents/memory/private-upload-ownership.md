---
name: Private upload ownership
description: Why file adoption must validate ownership across all endpoints, including older photo features
---

Possession of an object path is not evidence of ownership. Private upload adoption requires either the existing private ACL owner or authenticated upload-issuance provenance for an ACL-less object.

**Why:** A reward-specific ownership check did not stop an older memory-photo endpoint from overwriting a foreign file's ACL. Privacy must hold across every endpoint that can adopt the same object.

**How to apply:** Validate at the shared ACL-adoption boundary, reject foreign/public/unclaimed objects before inserting application records, and reuse existing same-owner private files without rewriting their metadata. Preserve compatibility for legitimately owned older files even when upload provenance predates its recording.
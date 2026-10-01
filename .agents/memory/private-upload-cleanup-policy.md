---
name: Private upload cleanup policy
description: Product boundaries for reclaiming abandoned uploads without destroying valid drafts or legacy assets
---

Limit automatic collection to authenticated upload provenance, including server-generated optimized photos with provenance. Treat every persisted image reference as live, including detached, unlocked, and claimed rewards and group covers. Unknown older files and public assets are outside automatic cleanup.

**Why:** A missing journey association is not evidence that a reward was abandoned. Upload age also cannot establish how long an image has been unused: a long-lived image may have just been replaced. Image optimization is shared by memories and group covers, so cleanup cannot assume generated photos belong only to memories.

**How to apply:** Give unreferenced uploads seven days from first observation without a reference; adoption resets that grace. Never delete immediately on cancel or failed save, since retries and drafts can still need the uploaded bytes. Keep browser retry reuse shorter than the server grace and scoped to the signed-in identity. Any new feature that stores object paths must participate in both the reference check and the adoption/deletion locking protocol.
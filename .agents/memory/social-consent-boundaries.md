---
name: Social consent boundaries
description: Event-time consent, separate sharing scopes, and protecting core habit transactions
---

Historical progress may appear in an explicitly shared journey summary, but enabling sharing or opening an activity page must not create retrospective activity or milestone notifications. Social events require a newly successful transition and consent already active at that transition.

**Why:** The social layer is deliberately lightweight and private by default. Turning an old private journey into a shared summary is not consent to announce its entire history.

**How to apply:** Keep activity reads free of event-generation side effects. Reflection edits and completion retries are not new successes. Re-check current access when displaying stored events or notifications so revocation and blocks remain effective.

Challenge acceptance authorizes safe participant progress only; group membership alone authorizes no personal habit progress. Character, achievements, memories, and rewards require their own independent consent.

**Why:** Joining a shared goal must not silently disclose unrelated personal content, especially for younger users.

**How to apply:** Preserve separate sharing decisions when adding new social projections or invitation flows. A shared summary never authorizes access to another participant's owner-only habit endpoints or generic private file URLs.

Social fan-out inside a rewarded check-in must not acquire other users' row locks through read-only permission checks.

**Why:** Cross-user authorization locks can interact with invitation and membership locks and abort the core check-in transaction. Adding social support must not make earned progress or rewards less reliable.

**How to apply:** Keep authorization reads nonlocking; explicitly serialize social writes before resource locks and test forced concurrency around invitations, leaving, blocking, and milestone fan-out.
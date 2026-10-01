---
name: Daily habit execution boundaries
description: Self-reported completion, known legacy schedule evidence, separate timer/time-awareness semantics, and consistency recovery versus paid streak repair.
---

An elapsed habit timer is execution context, not proof that the activity occurred and not a categorized time-awareness entry. Expiring an unclaimed scheduled day may create a missed-day state, but must not invent an actual value, completed check-in, or activity interval.

**Why:** The daily experience is deliberately self-reported and supportive. Treating clock time or absence of a visit as observed behavior would contradict the existing voluntary time-tracking boundaries.

**How to apply:** Keep habit execution sessions separate from time-awareness sessions. Use server timestamps for duration accounting, an explicit completion claim for success, and the user's real selected reason for missed-day reflection.

For legacy habits without a defined journey, a saved scheduled-day snapshot is evidence of an obligation even without a check-in. Unsaved historical dates remain unknown; the current cadence cannot reconstruct them.

**Why:** A plan proves that a day was scheduled, not that activity happened. Counting only successful records would hide known missed days, while filling calendar gaps would invent obligations.

**How to apply:** Keep eligibility and activity evidence separate. Include known elapsed scheduled dates, exclude saved rest dates and future dates, and derive successes only from real completed check-ins.

Consistency recovery is not the existing coin-paid legacy streak repair. The optional challenge-based feature remains disabled until its own journey-scoped limit and atomic attempt/completion rules are implemented.

**Why:** Restoring an old streak does not demonstrate completion of a missed-day challenge or enforce two opportunities per journey. Reusing it could misrepresent consistency and duplicate historical rewards.

**How to apply:** Preserve the legacy behavior without presenting it as consistency recovery. Any later enabling needs explicit challenge evidence, a journey-level cap, and a separate recovered-day policy.
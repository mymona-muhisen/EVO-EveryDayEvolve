---
name: Time awareness data boundaries
description: Product rules for gaps, suggestions, and generated analysis in time awareness.
---

The time-awareness feature treats tracking as voluntary self-reporting: only intervals a person explicitly labels count. A missed check-in or a paused session must not silently become activity time, even if a timer was running.

**Why:** The requested experience is supportive and manual rather than automatic surveillance. Filling gaps would attribute activities the person never confirmed and make the percentages misleading.

**How to apply:** Keep a distinction between a scheduled reminder and a recorded interval. Preserve gaps when check-ins are late, and base totals, percentages, patterns, and numeric reduction suggestions on confirmed records. Generated language may phrase those computed observations, not supply new facts or recommendations.
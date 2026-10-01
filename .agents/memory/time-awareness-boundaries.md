---
name: Time awareness data boundaries
description: Product rules for gaps, suggestions, and generated analysis in time awareness.
---

The time-awareness feature treats tracking as voluntary self-reporting: only intervals a person explicitly labels count. A missed check-in or a paused session must not silently become activity time, even if a timer was running.

**Why:** The requested experience is supportive and manual rather than automatic surveillance. Filling gaps would attribute activities the person never confirmed and make the percentages misleading.

**How to apply:** Keep interval boundaries separate from manual check-ins. Preserve gaps when check-ins are late, and base totals, percentages, patterns, and numeric reduction suggestions on confirmed records. Generated language may phrase those computed observations, not supply new facts or recommendations.

The 15/30-minute interval is silent tracking granularity, never a reminder: no sound, vibration, notification, forced check-in, or automatically opened activity chooser. Habit/social notifications remain separate. Pause must freeze active elapsed and interval accumulation; resume continues the partial interval.

**Why:** The user explicitly corrected the product experience: users notice passing time and choose when to record activity, without interruptions.

**How to apply:** Preserve this separation in future dashboard, timer, and notification changes. Display the tracking interval rather than a “next reminder,” and never infer activity or unknown historical active time from the running clock.
---
name: Habit Journey - relapse-recovery suggestion is display-only
description: The AI relapse-recovery feature computes a lower suggested habit target after a missed day, but nothing ever applies it — confirmed by reading both the API route and the frontend component.
---

`POST /api/ai/relapse-recovery` (in the api-server's ai.ts route) deterministically computes
`suggestedTargetValue = Math.max(1, Math.round(habit.targetValue * 0.5))` and returns it
alongside an AI-phrased coach message.

On the frontend, the "استعادة السلسلة" broken-streak panel (in the habit detail page) has a
button ("اسأل المدرّب عن بداية جديدة") that calls this endpoint and renders
`relapse.data.message` — but there is no follow-up call to update the habit. The suggested
lower target is computed and returned by the API, then never persisted or even shown as a
concrete number in the UI.

**Why this matters:** if a future task is "make the coach's suggestion actually apply" or
"fix adaptive targets," the fix is a frontend change (wire the relapse mutation's success
handler to call the habit-update mutation with `suggestedTargetValue`), not a backend one —
the backend already has the right number.

**How to apply:** treat this as a known product gap, not a bug to silently fix. It was
confirmed intentional-looking (message-only, no auto-apply) as of the last read; verify by
re-reading habits.tsx around the relapse-recovery block before assuming it's still the case.

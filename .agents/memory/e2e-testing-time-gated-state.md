---
name: E2E-testing time-gated game state
description: How to exercise streak-break/recovery and other date-dependent gamification flows in a single Playwright session without waiting real calendar days.
---

Habit/streak mechanics (and similar time-gated gamification logic) key off calendar dates
(`last_checkin_date`, `streak_broken_at`, etc.). A single automated test session runs in
minutes, so it can never naturally reach "a day was missed yesterday" the way a real user
would.

**Approach that works:** seed the DB directly to the target state right before the browser
step that exercises it, e.g.:
```sql
UPDATE habits SET current_streak = 0, longest_streak = 3, last_broken_streak = 3,
  streak_broken_at = CURRENT_DATE - INTERVAL '1 day' WHERE id = <habit_id>;
```
then reload the relevant page and continue the UI flow (recover button, AI relapse-recovery
prompt, etc.) as normal. This is a legitimate test technique, not a hack around the app —
it's testing the same code path a real missed day would trigger, just skipping the wait.

**Why:** without this, entire classes of gamification logic (streak breaks, weekly bonuses,
multi-day journeys) are effectively untestable in one sitting.

**How to apply:** when a test plan needs to reach a state that normally requires elapsed
real time, add an explicit `[DB]` seeding step immediately before the UI verification step,
and clearly label it as seeded (not organically reached) in the test report so results aren't
misread as "the app naturally produced this."

**Also watch order-of-operations:** UI conditionals that gate multiple actions behind the same
state (e.g. both a "recover streak" button and an "ask coach" button only render while
`currentStreak === 0`) mean you must test the action that changes the state (recover) LAST,
or the other button disappears before you get to it.

Journey fixtures must move the entire immutable calendar coherently, not just the journey start date. Prefer a fresh unexecuted fixture before shifting dates; do not rewind paid check-ins or unlocked rewards.

**Why:** A start-date-only backshift left saved day plans outside the new window. Lifecycle progress reached day 22 while the returned plan contained only one date, producing an apparent progress defect that was actually inconsistent test data.

**How to apply:** Seed the start date, saved day-plan dates, and any unexecuted daily state together; verify the complete 22-date window before browser execution. Leave genuine actuals, earnings, wallets, ledgers, and unlock timestamps untouched. Calendar completion does not imply 22 successful sessions; consistency must still reflect actual known successes.

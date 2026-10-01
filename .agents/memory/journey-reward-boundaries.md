---
name: Calendar journey reward boundaries
description: Valid calendar completion, durable reward eligibility, and exact versus unknown journey earnings.
---

A 22-calendar-day journey can contain misses and rest days. Valid final completion requires reaching calendar day 22 and a real successful check-in on its last scheduled date; a rest day 22 uses the preceding last scheduled date. It does not require 22 successful sessions.

**Why:** The fixed-duration challenge allows non-daily cadence and missed days, but a final reward must still have an explicit successful execution boundary rather than unlock merely because time elapsed.

**How to apply:** Preserve the server's final-eligibility rule in both map and reward redemption. Do not turn an expired, unsuccessful final opportunity into completion through historical creation or numeric edits; unchanged retries and reflection-only changes remain separate.

Journey-selected reward gating must survive changing the selection, unlinking the reward, and deleting its habit. Unlock is durable server-verified eligibility, not purchase or automatic spending.

**Why:** A gate based only on current associations can be bypassed by unlinking, redeeming, and reattaching. Already-redeemed historical rewards and genuinely never-selected legacy rewards must not be treated as unpaid new rewards.

**How to apply:** Retain required-gate evidence across association mutations. A different legitimately completed selected journey can supply unlock evidence; client changes cannot clear the requirement.

Eligibility must consider all owner-matched association evidence, even when the UI previews only its preferred selection.

**Why:** A secondary reward-to-habit association was overlooked by selection-only checks, allowing a reward to be created and redeemed before its journey completed.

**How to apply:** Audit alternative creation/linking paths as well as the main selection flow. Display priority is not a reason to ignore legitimate gate evidence.

Journey earnings are persisted event-attributed amounts, not current wallet balances or estimates based on current habit difficulty. Historical unknown XP and ambiguous coin records remain explicitly partial.

**Why:** Mutable difficulty and old payout markers cannot reconstruct exact historical awards. Pretending otherwise invents financial history.

**How to apply:** Display known subtotals with a partial-history notice. Never backfill unknown earnings by paying or estimating.
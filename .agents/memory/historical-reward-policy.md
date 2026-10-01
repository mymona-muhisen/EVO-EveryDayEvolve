---
name: Historical reward preservation
description: Why reward atomicity fixes must not automatically repair historical successful days
---

Do not retroactively grant or normalize rewards for historical successful check-ins while fixing reward atomicity.

**Why:** The requested safety fix explicitly excludes changing or duplicating old rewards. Historical reward flags can be inconsistent, and the coin ledger does not reliably attribute earlier payments to a particular check-in. An apparently unclaimed successful day is not sufficient evidence that its reward was never paid.

**How to apply:** Reward new successful transitions atomically and make retries idempotent. Any historical reconciliation needs a separately approved policy and evidence of nonpayment; do not infer that evidence from a false reward flag or zero recorded coins alone.
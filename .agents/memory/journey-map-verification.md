---
name: Calendar map viewport verification
description: Verify actual initial visibility at both ends of a scrollable map, including fixed navigation.
---

Check full current-node and character bounds against both the map viewport and the screen, rather than treating DOM visibility as viewport visibility.

**Why:** A final-day screenshot passed while day 1 was clipped below the map; direct navigation and reload also differed. The first and last calendar positions exercise different scroll boundaries.

**How to apply:** Check first direct entry and reload at day 1 as well as the terminal day, on phone and desktop. Include fixed bottom navigation in the visible-area calculation. A passing terminal screenshot alone does not validate initial-position visibility.

Verify map action controls too, using physical hit-testing rather than DOM visibility alone.

**Why:** The current node and character can be fully visible while a following mobile toolbar is covered by fixed navigation. A scrollable page does not make its initial action targets usable.

**How to apply:** At first entry, reload, and the settled return from fullscreen, measure the wrapped toolbar as well as the map and navigation. Check each action's full bounds and center hit target before scrolling; do not assume that fitting the map also fits the controls.

Freeze frontend source edits and workflow restarts during fullscreen pointer and focus checks.

**Why:** Hot reload can remount a portal overlay, end native fullscreen, and restore the background between a hit-test and a later pointer action. Measurements across different builds cannot establish a click-through defect.

**How to apply:** Finish the code batch before checking fullscreen interaction. When an overlay unexpectedly disappears during an active build, inspect hot-reload, fullscreen-change, and navigation events, then repeat only that interaction on a stable build before changing routing or repeating already-passed purchases.

Measure transient feedback after its entrance animation settles, not at its first DOM insertion.

**Why:** A real earned-level notification was captured above the viewport during its normal entrance, producing a false clipping finding. The settled notification was fully visible.

**How to apply:** Preserve actual earned-event and deduplication evidence, but wait for mounting and transition completion before judging screen bounds. If the original notification expires, label a rendering-only check explicitly; it is not evidence of another earned reward.
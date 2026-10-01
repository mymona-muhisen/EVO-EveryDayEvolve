---
name: Calendar map viewport verification
description: Verify actual initial visibility at both ends of a scrollable map, including fixed navigation.
---

Check full current-node and character bounds against both the map viewport and the screen, rather than treating DOM visibility as viewport visibility.

**Why:** A final-day screenshot passed while day 1 was clipped below the map; direct navigation and reload also differed. The first and last calendar positions exercise different scroll boundaries.

**How to apply:** Check first direct entry and reload at day 1 as well as the terminal day, on phone and desktop. Include fixed bottom navigation in the visible-area calculation. A passing terminal screenshot alone does not validate initial-position visibility.
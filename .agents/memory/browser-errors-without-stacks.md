---
name: Browser errors without Error objects
description: Diagnosing an unknown runtime overlay with an empty stack during layout changes
---

An unknown Vite runtime overlay with an empty stack can originate from a browser-generated error event without an Error object, rather than a thrown application exception.

**Why:** The runtime overlay may forward the event's error object without its message, leaving browser-generated errors without useful diagnostic text.

**How to apply:** Capture passive browser error-event messages and unhandled rejections as well as stacks before identifying a cause. Do not hide the overlay or suppress errors to make a test pass.
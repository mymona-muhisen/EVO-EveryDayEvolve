---
name: GitHub authorization channels
description: A working GitHub connector does not guarantee that shell Git credentials are valid.
---

Treat connector authorization and shell Git authentication as separate channels.

**Why:** The GitHub connector had working repository write access while a direct shell push failed with an invalid-credential error.

**How to apply:** Do not reconnect a healthy connector or request raw credentials merely because shell Git fails. Use the authenticated connector for GitHub operations when appropriate, and verify the destination reference and file hashes after a transfer.
---
name: Gemini model availability
description: Gemini model listings and actual generateContent availability can diverge.
---

Do not assume a model can generate content merely because Gemini's model listing includes it. When AI phrasing silently falls back after a key is configured, make a minimal generation request and classify its HTTP status before attributing the issue to credentials.

**Why:** A previously configured flash model appeared in the live model listing but generation returned HTTP 404 saying it was no longer available. Updating to an available flash model restored real responses without changing the app's deterministic metrics.

**How to apply:** When choosing or updating Gemini models in this project, test both plain-text and JSON generation with the same options used by the coach before relying on the model in authenticated routes. Avoid logging raw SDK error objects or credentials.
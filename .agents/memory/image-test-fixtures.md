---
name: Valid image fixtures
description: Browser image previews can accept PNG bytes that the server rejects.
---

Generate photo-test PNGs with a real image encoder and validate decoding/chunk CRCs before testing an upload. Do not assume a small copied base64 PNG is valid merely because the browser displays it.

**Why:** A synthetic PNG with invalid CRCs displayed in the browser but correctly failed server-side Sharp decoding. Repeated upload retries therefore looked like a save defect when the fixture itself was corrupt.

**How to apply:** Use Pillow or Sharp to generate test images. If an upload succeeds but memory creation returns an image-decode error, inspect the response and validate the fixture before changing image validation or ownership checks.
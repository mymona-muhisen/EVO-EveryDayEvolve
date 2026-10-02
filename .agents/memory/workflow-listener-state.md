---
name: Workflow status and surviving listeners
description: A failed workflow can coexist with a healthy older app process still occupying its port.
---

Do not infer that an app is offline from a failed workflow status when the error is `EADDRINUSE`; an older app process may still be serving requests.

**Why:** Managed workflow attempts failed while surviving frontend and API processes continued to answer requests on the expected ports.

**How to apply:** Compare the workflow status with actual HTTP responses and the exact listener process before retrying. Stop only verified stale processes for that artifact, then restart its managed workflow; do not change ports or stop unrelated services to hide the conflict.
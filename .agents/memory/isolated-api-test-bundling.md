---
name: Isolated API test bundling
description: Workspace bundling and complete schema dependencies for isolated API integration tests
---

When building isolated Node test bundles with esbuild, bundle workspace libraries rather than setting all packages to external. Externalized workspace packages may expose extensionless TypeScript ESM exports that Node cannot import directly. Externalize only packages that must be loaded at runtime, such as Express.

**Why:** An isolated route test initially built but could not load the workspace's generated schema entrypoint under Node's ESM resolver. Bundling that package resolved the mismatch without altering production code.

**How to apply:** For test-only esbuild runners that import workspace source, start with normal bundling and explicitly externalize the minimal runtime dependencies instead of using `packages: "external"`.

An isolated database fixture must include every table exercised by the imported route, including unrelated read-only dependencies, and the complete current columns when a query uses an unprojected select.

**Why:** Adding a dashboard assertion to a reward test reached an existing time-awareness query; the incomplete fixture produced an HTTP 500 even though the development schema was correct. A shared upload-provenance schema change also made an older isolated cover-image test return 500 before reaching its expected ownership rejection.

**How to apply:** When extending a route integration harness, account for its read dependencies as well as its writes. Sync shared-table fixture columns across affected harnesses, even when new fields do not appear in the tested request. Distinguish fixture/schema failures from application failures before changing production behavior.
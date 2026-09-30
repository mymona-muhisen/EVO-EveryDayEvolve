---
name: Isolated API test bundling
description: How to bundle isolated Node tests against workspace API modules without ESM resolution failures
---

When building isolated Node test bundles with esbuild, bundle workspace libraries rather than setting all packages to external. Externalized workspace packages may expose extensionless TypeScript ESM exports that Node cannot import directly. Externalize only packages that must be loaded at runtime, such as Express.

**Why:** An isolated route test initially built but could not load the workspace's generated schema entrypoint under Node's ESM resolver. Bundling that package resolved the mismatch without altering production code.

**How to apply:** For test-only esbuild runners that import workspace source, start with normal bundling and explicitly externalize the minimal runtime dependencies instead of using `packages: "external"`.
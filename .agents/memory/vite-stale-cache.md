---
name: Vite stale cache causes phantom dev-server errors
description: A Vite dev server misbehaving (blank preview, stale modules, phantom import/export errors) after dependency or config changes — fix by clearing the cache, not by reinstalling packages.
---

When a Vite-based dev server (a web artifact or the mockup sandbox) shows stale behavior after a dependency, config, or path-alias change — blank preview, "does not provide an export" errors for exports that clearly exist in source, or components not updating — clear Vite's cache before suspecting the package itself.

**Why:** Vite caches pre-bundled dependencies and transformed modules under `node_modules/.vite` (and sometimes a `.vite-temp` dir). This cache can go stale relative to source/config changes and produce misleading errors that look like real code or dependency bugs.

**How to apply:** Remove the cache directories (`node_modules/.vite`, `.vite-temp`) for the affected package and restart its workflow, before reinstalling packages, rewriting imports, or otherwise changing code to chase the phantom error.

# ADR 0001: One daily Munword interface and browser engine

Status: Accepted by the user, 2026-10-05.

## Context

The hosted React/browser engine and separate desktop HTML/Python workflow diverged, causing stale UI versions and duplicate frontend changes. Country normalization must not introduce independently maintained tables or break API/CLI users.

## Decision

Desktop mounts the same `app/page.tsx` component and browser formatting engine as the website. Build a self-contained offline JS asset and the same compiled global CSS. Python remains a loopback asset server and a compatible API/CLI implementation. Both engines load one country table and follow identical, exhaustively cross-checked identity/display/sorting policy.

## Alternatives considered

1. Delete Python and migrate API, batch processing and all installers to Node: one core, but breaks compatibility and adds a runtime migration unrelated to the immediate feature.
2. Keep two frontends and make them similar: low initial effort, ongoing drift and duplication.
3. Run Python in the browser via WebAssembly: runtime/dependency and loading cost, substantial unrelated migration.

## Consequences

Daily users now have one UI and one engine; Python compatibility still has two algorithm implementations. This boundary is explicit, not a claim that Python and TypeScript are literally the same source. Shared fixtures, complete country-table parity tests and package/content guards enforce agreement. Source desktop users build assets once; shareable desktop packages include them and do not require recipient Node. Missing assets fail clearly instead of serving a hidden old UI.

## Follow-up

Keep offline UI/race tests, country parity and release-asset checks in the release gate. A future complete single-core API migration is a separate decision with installation and batch compatibility acceptance tests.

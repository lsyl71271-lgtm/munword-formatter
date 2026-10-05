# v1.8.2 — Claude review integration

Baseline: v1.8.1 (`762fcbe`). The external review was read in full; claims were treated as probes, not proof. No private documents or credentials are included in this repository or review package.

## Changes

- Shared `field-edit-policy.json` distinguishes ordinary empty Tab/CR/text-wrapping breaks from page/column breaks and protected nodes. Browser and Python parsers recognize multi-line field values. Full-name expansion, identity deduplication and existing sorting now work on plain separated lists. The independent guard re-proves the original countries and checks the whitelist even for manually authorized lists. Revisions, hidden/struck text, links, fields, bookmarks, original numbering and resources stay protected.
- Step 03 reports each changed field as written or unwritten. Missing field lines produce an explicit warning; they are not invented, inserted or silently reported as applied. Protected edits remain refused with a reason. Python list-emphasis failures now have explanations; preserved complex fields produce a review warning rather than an empty 409.
- Country-name whitespace comes from the same explicit Unicode set in both engines. FEFF no longer gives different country identities; zero-width space remains unrecognized. Country labels use the existing shared output-label policy regardless of whether a short name was expanded. Label/separator changes are logged, and template generation uses that policy too. Country data and historical/ambiguous-name policy are unchanged.
- Offline builds carry source/asset SHA-256 provenance. Desktop packaging verifies this against the staged source and current assets, refusing stale or changed UI bundles. Extracted packages can verify and rebuild without Git. macOS installer verifies the build before changing an installation and requires Python 3.12+ rather than silently creating a system-3.9 environment; unsupported existing environments are left untouched.

## Verification and scope

New regression probes reproduce the original failures before fixes, and cover Chinese/English, Tab/CR/soft breaks, ordinary and manually edited lists, absent fields, protected page/column breaks, invisible characters, independent guard rejection and repeat processing. Node 175 unit tests and 2 rendered-HTML tests, Python 182 tests on both 3.12 and legacy compatibility 3.9, production/offline builds, TypeScript, lint and staged-source audit passed. Source audit found no detected credentials, personal paths or excluded files in 190 tracked files; this heuristic is not a guarantee of detecting every possible secret.

Independent full format readback on the frozen 287 cases (23 acceptance inputs plus 264 prior outputs, not 287 new corrupted originals) matches between engines and remains unchanged on a second pass in each engine. Compared with v1.8.1, 285/287 are completely identical. The remaining two are one position-paper sample and its previous output: only the country header changes from `国家/席位：日本国` to `国家：日本国`, with a trace. Every other row, blank, font/size/emphasis, numbering and page property is identical; no body/property exclusions were used. The final release receipt also records archive readback and publication results.

This release does not claim universal Word/WPS pixel equality or universal idempotence. Claude reported eight older adversarial idempotence failures and two unusual-title parity cases outside the local frozen corpus; their original cloud probe files were not supplied. Those require separate, reproducible rendering/semantic tests before changing header inference or title rules. Real Windows installation and native Office rendering are not verified by Linux/macOS structural tests. Large documents still run synchronously in the browser. No new dependencies, speculative country aliases or blanket guard exemptions were introduced.

## Review handoff

Use `CLAUDE_REVIEW_REQUEST.md` with the source/offline-assets ZIP. Re-run the README gates in a clean environment; inspect missing/complex fields and protected-text probes as well as the successful sample corpus. Do not count only text extraction as format verification.

Rollback is the previous GitHub commit and existing Sites v1.8.1 saved version 16. Website publication uses a matching source snapshot without changing its audience. No local installation or user documents are overwritten by this release task.

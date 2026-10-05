# v1.8.1 — final safety, compatibility and maintenance audit

Baseline: `f1d0ac721f32811def67d2cebbb896e932b04e5b` (v1.8.0). Same UI, document rules, six routes, Step 03 and country expansion. No fixture-specific rules, private inputs, rewritten body text, new cloud storage, audience changes or database migration.

## Reproduced defects and fixes

- Reject invalid XML byte encoding instead of silently substituting U+FFFD; check local ZIP flags/method against central metadata. Python now applies the same unsupported-method/path/XML-size policy before inflation, for API AND direct pipeline/CLI callers. Invalid DEFLATE/filename encoding is a file error rather than an internal 500.
- Relationship protection uses namespace-aware elements, independent of prefix spelling. Duplicate IDs cannot hide an earlier target by overwriting a map entry; `.RELS` is checked too. Original relationships, resources, revisions, text and numbering checks remain enabled.
- Reject invalid XML characters in Step 03/template fields with a readable input error. Python no longer silently ignores an explicit manual edit of a complex scalar field: it fails safely and identifies the paragraph. Automatic complex-field edits still preserve the original and explain why.
- Position-paper body recognition uses the parsed header boundary, not a scan of every body paragraph for words such as “议题：”. A quoted label in the body can no longer prevent earlier clauses from receiving their existing formatting.
- Bound declared AND chunked API request bodies at 21 MiB before multipart parsing writes temporary files. This is separate from the 20 MiB DOCX and expanded-package limits. Origin/Host checks and threadpool processing remain.
- Cancel obsolete file work before expensive parsing/generation. Template lazy-loading now discards results when the type/fields change or the component is unmounted. It does not download an obsolete draft or let old completion clear a new operation's state.
- CLI and release ZIP creation use atomic create-if-absent. Explicit CLI `--overwrite` retains its documented behavior; input documents remain protected.
- macOS/Windows installer preflight checks all source directories/version before stopping/replacing a runtime, and refuses installation from the target directory itself. The legacy macOS startup helper verifies the service identity instead of treating any HTTP health page as Munword.

## Safe simplification

- Shared archive/request limits in `shared/package-policy.json`, not separate frontend/backend constants.
- One pipeline package validation, removing redundant API/CLI decompression. Cached country sort keys; identical sort/display results.
- Removed unused `pypinyin` runtime dependency (the shared offline reading table remains), a defective/redundant header-boundary helper, and the retired-UI branch of the optional smoke script.
- Cross-platform Node typecheck launcher replaces POSIX-only environment syntax. Architecture navigation now describes the actual unified daily UI, not a deleted `local_web/app.js`.
- Existing large formatting modules and unused platform scaffolding were NOT blindly deleted/replaced. Size alone does not prove code is dead; a major algorithm/framework migration would increase regression risk here.

## Open-source reuse and security research

Reviewed upstream [fflate](https://github.com/101arrowz/fflate), [docx-preview](https://github.com/VolodymyrBaydalka/docxjs), [python-docx](https://github.com/python-openxml/python-docx) and GitHub's dependency advisories. Existing ZIP/parser/preview/template components already serve the relevant boundaries; no suitable drop-in replacement implements Munword's preservation rules and PKUNMUN layout policy. Retained those integrations rather than importing a second formatter or forcing a framework upgrade.

Updated pinned Next/React/RSC/Vite/ESLint configuration and compatible transitive dependency patches; lockfile records the exact graph. Full `pnpm audit`: initially 62 advisory entries (3 critical), after upgrades 1 high, 0 critical. The remaining [braces recursion advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) has no published upstream fix as checked 2026-10-05. It is reached through development glob tools, not DOCX formatting; document text is never passed to glob patterns. No fictitious 3.0.4 version, suppression or unreviewed fork was installed. Do not interpret “production path not used” as a universal security guarantee.

OSV query of the updated local Python 3.12 environment found no reported advisories in its 27 installed packages, including the updated pip installation tool (2026-10-05 snapshot, not a future security guarantee). Python 3.9 compatibility is retained, but its available AnyIO, Starlette, multipart and other dependencies have additional unpatched advisories. Several affected APIs are unused here (StaticFiles, HTTPEndpoint, AnyIO process pool/TLS); upload bounds and scope-based origin checking mitigate some used paths, but do NOT prove those dependencies safe. Python 3.12+ with current pip is recommended; do not expose the legacy engine publicly. The current user's local runtime is migrated with a scoped rollback backup; old-install compatibility is not falsely described as a vulnerability-free release. Optional QA/dev dependencies and native OS runtimes also need their own updates.

## Verification

Completed release checks on 2026-10-05:

- Node: 170/170 unit tests plus 2/2 rendered-HTML tests. Production and offline builds, TypeScript and lint pass. Frozen-lockfile installation from the official npm registry passes; an incomplete offline cache was not mistaken for a code failure.
- Python: 177/177 on 3.12 and compatibility 3.9; 177/177 also pass in the updated local 3.12 runtime. Expected CLI refusal-to-overwrite messages are negative tests, not failed suites. Python compilation and macOS shell syntax checks pass.
- Independent full readback: browser vs v1.8.0 baseline, Python vs baseline, browser vs Python, and repeat processing by each engine all match exactly for all 287 cases. No comparison exclusions or Step 03 edits.
- Source/index audit: 182 source files, no detected credential, personal-path or excluded-file findings. Existing icons and synthetic sample thumbnails remain reviewed assets. Heuristic scanning is not proof that every possible secret can be detected.
- Fresh desktop-source ZIP: 193 payload files plus manifest; CRC, every extracted SHA-256, executable modes, version, offline asset routes and compatibility API country expansion/body preservation pass. This is a source/offline-assets package, not a bundled Python executable.
- Local service health reports v1.8.1 and the expected six pipelines. The shared UI's synthetic DOCX upload, recognition, generation, original/output preview and country-change diagnostics pass without filling Step 03. No browser-console errors were observed. The in-app browser did not expose a completed-download event; native Safari download verification was unavailable while the Mac was locked, so actual native-browser download was not claimed as verified.

Publication provenance is the final GitHub commit and the saved Sites version built from matching source. Deployment success/URLs are checked after these source gates, rather than embedding a future commit hash in its own document.

The corpus contains 23 original synthetic acceptance inputs plus 264 prior formatted outputs, not 287 new original corrupted inputs. Local-only outputs are ignored and not deployed. Full independent readback includes blank paragraphs, text, numbering, paragraph/page geometry and per-character font/size/bold/italic/underline; no Step 03 field filling and no exclusions to hide differences.

Native Windows installation and Word/WPS rendering were not verified on actual Windows/Office hardware in this audit. Structural equality is not a pixel-identical pagination claim. Browser formatting remains synchronous; large-document main-thread blocking and unusual OOXML/style semantics still merit a separately scoped change with rendering baselines.

## Rollback

Keep baseline commit and Sites version 15, and back up the scoped local runtime before updating. Roll back if health/UI assets/version disagree, generation fails, or non-authorized text/numbering/resources change. Do not reset unrelated user changes or delete original documents. No credentials are checked in and GitHub stays Private.

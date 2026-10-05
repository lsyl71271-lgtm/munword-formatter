# Architecture navigation (v1.8.3)

This is a navigation guide for reviewers, not a redesign or a promise of complete semantic recovery.

## Entrypoints and execution boundaries

| Boundary | Source | Responsibility |
| --- | --- | --- |
| Browser UI | `app/page.tsx` | Four-step workflow, metadata confirmation, download, optional API override |
| Browser DOCX | `app/docx-browser.ts` | Parse, classify, format and repackage OOXML |
| Browser protection | `app/docx-safety.ts`, `app/content-guard.ts` | Archive limits, visible text, numbering and protected parts |
| Local UI | `local_web/index.html`, `local_web/main.tsx` | Mount the same `app/page.tsx`; offline assets built from the SAME browser engine and stylesheet |
| API startup | `backend/run.py`, `backend/app/main.py` | Loopback service, static resources, health, parse/format endpoints |
| Backend workflow | `backend/app/pipelines.py` | Six document-type pipelines and validation orchestration |
| Recognition | `backend/app/parser.py`, `models.py`, `structure_repair.py`, `semantic_policy.py` | Intermediate model and conservative structural decisions |
| Backend formatting | `backend/app/formatters/` | Shared handbook pass and document-type implementations |
| Backend protection | `backend/app/content_guard.py`, `docx_package.py` | ZIP/OOXML and content/resource checks |
| Policy | `shared/` | Document/workflow rules, UNTERM/M49 country snapshot, pinyin sorting, archive/request safety budgets |
| Deployment | `vite.config.ts`, `worker/`, `build/` | vinext/Cloudflare build and hosting metadata |

Read the entrypoints first, then follow imports. `templates/` documents the rule-based template approach. There is no private template required for standard tests. Database/auth scaffolding remains in the tree for review but is not proof of an active authenticated application.

## End-to-end execution

1. `app/page.tsx` owns the four-step session. Changing file/type/recognized metadata/options invalidates in-flight work and prior generated results. Step 03 remains editable; automated QA uses recognized values without filling it.
2. Default browser mode: `docx-safety.readPackage` checks ZIP bounds, flags, paths, sizes, compression methods, CRC and XML encoding/DTD/depth. `docx-browser` reads Word paragraphs, inherited styles and native lists, performs conservative structure repair, and builds a six-type intermediate model. An XML/ZIP error is not disguised as a formatting success.
3. Generation validates review input, plans country identity/display/sorting through `countries.ts` and `shared/country-names.json`, then applies shared layout rules and type-specific formatting. It does not rewrite arbitrary body text or renumber native/manual values to hide loss.
4. `content-guard.ts` independently checks authorized field/structure changes, text, numbering, revisions, relation targets and media bytes. Failed checks withhold the DOCX. Diagnostics explain existing results; they are NOT a second parser or a visual compliance certificate.
5. Preview uses `preview-safety.ts` on a COPY and `docx-preview` in an isolated iframe. External/missing picture targets are stripped from that preview copy; the downloadable document's relationships/resources remain untouched. Template generation is an independent user-input path that eventually passes through the protected formatter.
6. Local daily mode: FastAPI serves the prebuilt React bundle and CSS at port 8000, but default formatting still runs in the browser. `local_web/studio-tools.ts` is a retained legacy asset endpoint, not a second active daily UI.
7. Optional API/CLI mode: `pipelines._analyze` validates the package once for every caller, repairs structure, parses a model, applies allowed overrides, runs the formatter and strict guards. API checks origin/Host and bounds the body BEFORE multipart spooling; file processing runs in a threadpool with a fresh pipeline per request. The CLI does not fill step 03 or upload documents, and creates outputs atomically without replacing an existing file unless explicitly authorized.
8. `build-local-tools.mjs` bundles offline assets/licenses. `package-release.py` packages only reviewed Git-index source plus enumerated generated offline assets, with CRC/hash/mode readback. Installers fail preflight before replacing a healthy runtime when sources are incomplete or the source equals the installation directory. Sites builds `worker/index.ts`/vinext; no Python service or private test corpus is deployed.

## Shared versus compatibility code

Daily web/desktop: one React UI, one browser formatting engine, one CSS source. Python compatibility has its own implementation, not literally the same algorithm file. Both consume shared JSON and must pass parity tests. Country display identity and sorting keys are separate; whole-name matches only, with unresolved/complex fields preserved and reported. Archive budgets are centralized in `shared/package-policy.json`; API's 21 MiB multipart allowance includes the browser/API's 20 MiB file limit plus form overhead.

Auth (`app/chatgpt-auth.ts`), D1/Drizzle (`db/`, `drizzle/`, `examples/d1/`) and the image worker adapter are retained platform scaffolding, not new product features. Do not trust authenticated-user headers outside the trusted Sites boundary or expose the loopback API publicly without a separate authentication design.

## Regression boundaries to preserve

1. Preserve original text, explicit numbering, start/restart/skips, cross-references, revisions, relationships and media. Do not weaken protection to make a difficult fixture pass.
2. Keep manual confirmation available. Automated tests must not repair their input by filling step 03.
3. Use general policy rather than fixture text, filename or country-specific exceptions.
4. Compare engines using the committed parity fixture and Python/Node suites. Shared JSON alone does not prove equivalent behavior.
5. Validate visual output with actual fonts and a Word-compatible renderer when changing layout. Structural/XML assertions cannot prove identical pagination.

## Remaining review targets

- Large browser module and mirrored backend logic: duplication, semantic drift and separation of parsing/normalization/formatting.
- Browser main-thread work and untrusted ZIP/XML resource budgets.
- Legacy sample scripts, installer metadata and platform-specific service behavior.
- Difference between tests of document integrity, tests of formatting structure, and real rendered-document comparison.
- Public deployment boundaries: local backend is not a production authenticated service.
- A dated country snapshot is not a live guarantee. Unknown/ambiguous/historical/observer input still needs human review.
- Main-thread browser processing and platform/font rendering remain separate future work; do not replace the formatter/introduce a Worker or new framework without resource, UI and rendering baselines.

See [v1.8.3 DR numbering](release-1.8.3.md), [v1.8.2 review integration](release-1.8.2.md) and [v1.8.1 verification and dependency decisions](release-1.8.1.md). Field separators and Unicode country whitespace are shared in `field-edit-policy.json`; offline build provenance is verified against `local-build-policy.json`. `dr-numbering-policy.json` defines the handbook's bilingual four-rank DR notation. `app/dr-numbering.ts` and `backend/app/dr_numbering.py` resolve parent/child evidence before punctuation; manual-marker edits and per-list-instance native overrides are independently checked by the content guard. Ambiguous ranks preserve their markers and associated parent colons, with review warnings. Source lint and structural regression results do not prove identical Word/WPS pagination.

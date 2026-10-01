# Architecture navigation (v1.6.3)

This is a navigation guide for reviewers, not a redesign or a promise of complete semantic recovery.

## Entrypoints and execution boundaries

| Boundary | Source | Responsibility |
| --- | --- | --- |
| Browser UI | `app/page.tsx` | Four-step workflow, metadata confirmation, download, optional API override |
| Browser DOCX | `app/docx-browser.ts` | Parse, classify, format and repackage OOXML |
| Browser protection | `app/docx-safety.ts`, `app/content-guard.ts` | Archive limits, visible text, numbering and protected parts |
| Local UI | `local_web/index.html`, `local_web/app.js` | Same workflow through the loopback Python API |
| API startup | `backend/run.py`, `backend/app/main.py` | Loopback service, static resources, health, parse/format endpoints |
| Backend workflow | `backend/app/pipelines.py` | Six document-type pipelines and validation orchestration |
| Recognition | `backend/app/parser.py`, `models.py`, `structure_repair.py`, `semantic_policy.py` | Intermediate model and conservative structural decisions |
| Backend formatting | `backend/app/formatters/` | Shared handbook pass and document-type implementations |
| Backend protection | `backend/app/content_guard.py`, `docx_package.py` | ZIP/OOXML and content/resource checks |
| Policy | `shared/` | Layout and sorting rules shared by both engines |
| Deployment | `vite.config.ts`, `worker/`, `build/` | vinext/Cloudflare build and hosting metadata |

Read the entrypoints first, then follow imports. `templates/` documents the rule-based template approach. There is no private template required for standard tests. Database/auth scaffolding remains in the tree for review but is not proof of an active authenticated application.

## Regression boundaries to preserve

1. Preserve original text, explicit numbering, start/restart/skips, cross-references, revisions, relationships and media. Do not weaken protection to make a difficult fixture pass.
2. Keep manual confirmation available. Automated tests must not repair their input by filling step 03.
3. Use general policy rather than fixture text, filename or country-specific exceptions.
4. Compare engines using the committed parity fixture and Python/Node suites. Shared JSON alone does not prove equivalent behavior.
5. Validate visual output with actual fonts and a Word-compatible renderer when changing layout. Structural/XML assertions cannot prove identical pagination.

## Useful review targets (not changed by this import)

- Large browser module and mirrored backend logic: duplication, semantic drift and separation of parsing/normalization/formatting.
- Browser main-thread work and untrusted ZIP/XML resource budgets.
- Legacy sample scripts, installer metadata and platform-specific service behavior.
- Difference between tests of document integrity, tests of formatting structure, and real rendered-document comparison.
- Public deployment boundaries: local backend is not a production authenticated service.

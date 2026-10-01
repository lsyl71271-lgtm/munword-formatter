# v1.7.0 Document studio integration

## Added

1. Actual DOCX HTML previews, opt-in and sandboxed, for original and generated
   files. Engine ZIP limits run before the preview parser. External preview
   relationships and HTML altChunks are not loaded; original downloads remain
   untouched. HTML previews are not Word pagination or visual certification.
2. Read-only structural diagnostics, using one shared explanation/required-field
   policy across browser/Python. Reports separate structural checks from visual
   checks and expose warnings, recognized roles, levels and paragraph locations.
3. Independent new-document generation through docxtemplater's free MIT core,
   followed by the existing six-type academic formatting engine and guards.
   Uploaded originals never use the template reconstruction path.
4. Safe Python single-file/batch CLI; reproducible source/desktop packaging with
   SHA-256 inventory and extraction readback; cross-platform web start/build
   commands; offline local-tool bundle sharing the same browser modules.

## Visual QA

`scripts/visual-qa.py` converts a DOCX using a supplied local renderer or an
explicitly configured loopback Gotenberg service, produces page images and a
JSON report, checks a font-size ceiling and required italic phrases, and can
compare same-content reference pages. It never runs automatically in the public
website and never treats a successful conversion as full academic compliance.

The optional service configuration is `deploy/visual-qa.compose.yaml`. It
binds only loopback and disables URL downloading, webhooks and Chromium routes.
The adapter refuses redirects and linked external resources. Public hosting
this service requires a separate security/privacy design and is not included.

## Preservation

The academic policy and both formatting engines are unchanged. Step 03 remains
editable by humans; automated regressions and the batch CLI do not fill it.
No LLM, account, paid module or external document-processing service is required
for the default website. The repository remains private.

## Limits

Font availability can change rendering; Word/WPS/LibreOffice may paginate
differently. Unknown structures still need review. Templates do not recreate
missing original content. The desktop-source package still requires Python and
first-install dependencies; it is not a signed standalone executable. Real
Windows/macOS installer execution requires platform acceptance testing.

## Validation completed for this release

- 84 Node unit tests, 88 Python tests and 2 server-rendered HTML tests passed.
- Production build, TypeScript checking, ESLint and source hygiene scanning passed.
- Real Chromium tests covered web and local-API upload, download, both DOCX
  previews, diagnostics and separate template generation without editing step 03.
  The web test also covered a 390px viewport and rejected external document requests.
- Rendered and inspected 12 bilingual templates and 11 existing acceptance outputs
  (23 pages). Local PDF checks exercised the font-size ceiling, required italic
  phrase and same-content pixel comparison; structural checks are not a claim
  that arbitrary documents are visually perfect.
- The Gotenberg HTTP contract and safety checks were tested with mocks. No Docker
  installation was available, so actual container conversion remains unverified.
- An optional CI workflow is supplied as `docs/ci.example.yml`; it is not enabled
  automatically and needs a separate workflow-write authorization to activate.

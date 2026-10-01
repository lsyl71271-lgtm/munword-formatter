# v1.7.1 Independent review integration

## Scope

Integrates Claude's review of v1.7.0 after an independent Codex review. No UI
redesign, new LLM dependency or change to the academic font/spacing policy.
Step 03 remains editable for humans; automated upload tests do not fill it.
The GitHub repository remains private and the existing website audience is unchanged.

## General fixes

- Header metadata is recognized only before the body. Body paragraphs starting
  with a metadata-like label are preserved, including during manual header edits.
- Body-level content controls/custom XML participate in parsing and content
  guards. Table/text-box text is retained but is not misclassified as a clause.
- List recognition handles full-width periods, letter/Roman sequences and
  parenthesized digits; indentation is used only in list context. Normalized
  house indents remain stable when processed again. Original numbers are not invented.
- Partial hidden/deletion formatting is preserved and reported, including
  properties inherited from styles and text in tables/text boxes. Whole-document
  uniform damage is cleared from both runs and inherited defaults so it does not
  reappear on opening. Tracked revisions remain separately protected.
- Both engines normalize font tables/themes consistently, retain math fonts,
  clear source document grids and write run properties in schema order.
- Preview copies remove external pictures whose relationships were stripped;
  downloadable source content remains untouched.
- Changes during generation discard stale responses. Changes after success
  clear obsolete results/validation. All generation and manual-edit controls remain.
- XML safety scanning catches UTF-16 declarations including BOM-less,
  whitespace-prefixed forms. Loopback host restrictions stay enforced.
- Batch input skips Word lock files and rejects case-insensitive output collisions.
  Release packaging uses tracked files only and refuses unreviewed untracked files.
  It preserves Git executable modes, including application entry points.
- macOS launcher checks both the formatter service identity and requested
  version instead of accepting an unrelated or stale service on the configured port.

## Independent release verification

See the test suites for reproducible regressions. Release checks cover both
engines, type/lint/build checks, local browser upload/download/preview workflows,
and rendered bilingual stress fixtures. Generated/private review material is
excluded from Git and release packages. Publishing evidence is reported with
the release commit and native deployment result, not inferred from a preview.

- 117 Node unit tests, 117 Python tests on both Python 3.12 and 3.9, and
  2 server-rendered HTML tests passed. TypeScript, ESLint and production build passed.
- Real isolated Chromium runs passed website/local-API upload, automatic
  recognition, download, both document previews, diagnostics and independent
  template generation; website mobile checks passed. No external document
  requests were observed and step 03 was not filled.
- Rendered and visually inspected 24 outputs from 12 bilingual corrupted
  fixtures (both engines). All 12 engine pairs were pixel-identical using the
  same local renderer/font catalogue. This is a scoped comparison, not a claim
  of identity for arbitrary input or every Word/WPS installation.
- Source hygiene checks found no credentials/personal paths in the release
  files. Private review outputs and local machine commit identities were not
  imported into the release history.

## Known limits

- Ambiguous missing markers and numeric-parenthesis hierarchies still need human
  review; indentation alone cannot reliably reconstruct an author's intent.
- Word/WPS pagination depends on installed fonts and renderer behavior. Local
  LibreOffice rendering is not a promise of pixel identity on every computer.
- Large browser formatting is synchronous and can temporarily occupy the UI thread.
- HTML preview is a protected approximation, not certified Word pagination.
- Four existing cross-engine repair cases involving revisions/hyperlinks remain
  different in paragraph boundaries; protected text is not silently discarded.
- Real Windows installer and Word/WPS acceptance, and live Gotenberg container
  conversion, require separate platform testing. The source package is not a
  signed, runtime-inclusive standalone executable.
- Optional CI remains an example, not an activated GitHub workflow.

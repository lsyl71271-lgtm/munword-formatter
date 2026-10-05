# v1.7.2 independent integration checks

The release combines Claude's cloud audit (PR #1, frozen at `d340f1062906c8e20751ea5e0526f291e6208056`) with the local review's five shared Chinese clause prefixes. The local review's older code was not copied wholesale. Codex independently checked the frozen source and added three Python 3.9 compatibility regressions. No fixture-specific formatting rules were introduced.

## Verified locally

- Node unit suite: **153/153** passed.
- Python suite: **156/156** passed on both Python **3.9** and **3.12**, using freshly installed declared dependencies. The additional tests check keyword-free `zip`, complete/partial/empty headers for all six document types, and resolution parse/format API requests without manual overrides.
- Production build, HTML tests **2/2**, TypeScript checks and ESLint passed. Current built product pages contain `v1.7.2`, not `v1.7.0` or `v1.7.1`.
- **23** standard regression inputs (12 generated bilingual corrupt-format fixtures and 11 repository acceptance inputs): both engines' output readbacks match each other and the pre-release `6c0b847` baseline exactly.
- **264** local historical stress inputs: both engines generated every document without error-level refusal, and all output readbacks match across engines. No step-03 fields were filled or changed by the automated runs. Private inputs and output files remain local and ignored by Git.
- Reprocessing each engine's outputs leaves readbacks unchanged: **23 + 264** cases per engine.
- **12** bilingual samples per engine were rendered to PDF/PNG in the same LibreOffice environment. Corresponding page pixels are identical, and the 24 final DOCX files' uncompressed ZIP parts match the rendered copies exactly. This does not establish Word/WPS rendering equivalence.
- Two additional synthetic UI cases cover a partially hidden amendment title and a resolution containing hidden non-BMP characters. Both engines now generate them safely; the earlier browser implementation rejected both, while Python rejected the amendment.
- Source audit reported no credential, personal-path, excluded-file or other configured findings. Only the existing synthetic DOCX thumbnails and existing application artwork are binary assets.

## Baseline changes reviewed

The 264-case baseline comparison is intentionally not all unchanged: Python matches its old output in 259 cases, and the browser in 255. The nine affected inputs fall into three general fixes:

1. Four inputs now use the same embedded-subclause paragraph boundaries in both engines; Python already had those boundaries.
2. Three inputs retain hidden title/metadata-label characters and warn instead of deleting them or refusing the whole download.
3. Two inputs retain protected sentence-ending text/whitespace instead of rewriting it.

Exact readback compares paragraph order, blank paragraphs, text, displayed numbering, per-character bold/italic/underline/font/size, paragraph alignment/indent/spacing, and page dimensions/margins. It does not normalize away differences. Content/package/semantic-mark guards separately check protected document contents.

## Release boundaries

The interface and manual step-03 entry remain available. Automatic content edits that would remove hidden or struck characters roll back only that paragraph and produce a warning; the final guard remains strict. This is not permission to erase semantic marks to make a damaged file resemble a reference.

Known limitations remain in [the audit record](audit-2026-10.md) and [release notes](release-1.7.2.md): unusual first-line titles may be aligned differently by the engines, long browser jobs still run on the main thread, some Word style-toggle behavior needs real-Office verification, and native Windows/macOS installers were not exercised on real systems in this integration. No unverified Word compatibility switch was added.

The in-app browser visibly completed recognition and generation of the synthetic Unicode case with content/package/font checks passing and protected-content warnings. Its download-event hook did not return a file path; that observation alone is not proof of a saved browser download. Engine-generated DOCX packages and the local API download were checked separately.

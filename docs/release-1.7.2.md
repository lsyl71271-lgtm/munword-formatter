# v1.7.2 Review fixes

## Scope

Fixes from the 2026-10 independent review of v1.7.1 (record:
[audit-2026-10.md](audit-2026-10.md)). No UI change, and the academic
(学标) font, size, spacing and indent parameters are unchanged. Step 03
remains editable for humans; automated tests do not fill it.

## Content safety

- Hidden and struck-through text keeps its marks through every rewrite (country
  lists, signature lines, labels, clause endings). Both engines' guards check
  that marked characters survive in order; the browser now compares them by
  code point, so emoji and CJK Extension B text no longer trigger a false refusal.
- Every automatic rewrite (title word, label, marker, clause ending) compares the
  paragraph's hidden and struck text before and after; if marked characters
  would be deleted or lose their mark, only that paragraph is rolled back, with a
  warning, instead of the whole download being refused. The final guard is
  unchanged. Step 03 edits of such a title are still refused, as before.
- Clause endings go after REF field results and hyperlinks, and before trailing
  line or page breaks; endings formed by hidden or struck text are left alone.
- Whole-document damage is cleared from document defaults and the styles the
  body uses only; hidden notes in footnote- or header-only styles stay hidden.

## Two engines, one rule

- Shared policy now holds the language rule and the embedded-subclause rule
  (working papers, directives, resolutions): same paragraph boundaries in both
  engines, links and revisions wholly on one side no longer block a split.
- Style inheritance: default paragraph styles not named "Normal" (Chinese Word
  uses "a"), text-box runs, list levels linked through `lvl/pStyle`, and the
  default-style stop for bold/italic/underline.
- Chinese clause openings added: preambulatory 深切关切, 深表关切, 进一步回顾;
  operative 促请, 进一步呼吁. Words in both lists follow the clause's place.
- XML nested deeper than 256 levels is reported as a file problem in both engines.

## Step 03, local engine, packaging

- Step 03 edits of labeled position-paper fields are accepted; browser edits touch
  header lines only; country inputs keep what was typed.
- The local engine refuses cross-site browser POSTs; dependencies updated
  (lxml 6.1.3; fastapi/python-multipart with published fixes).
- Release packages are built from the Git index; Windows and macOS launchers
  check the engine version; macOS retries a busy port once a minute and keeps
  one previous log.
- Browser generation parses the upload once (output unchanged, ~10-15% faster).

## Verification

- 153 Node unit tests and 153 Python tests (Python 3.9, 3.12, 3.13); build,
  2 rendered-HTML tests, typecheck, lint and source audit pass.
- The 23 repository samples produce character-identical output before and after
  in both engines, identical across engines and stable on reprocessing; 22
  synthetic adversarial cases are identical across engines.

## Known limits

- In a justified article paragraph, Word stretches the line before an inserted
  line break; the compatibility setting that avoids it is not added without Word testing.
- Toggle properties set in both paragraph and character styles are not combined
  as Word does; unverified in Word.
- Browser formatting still runs on the main thread.
- A first line that does not match the title pattern (e.g. "决议草案（修订稿）") is
  formatted as the title by the Python engine only; unchanged from v1.7.1.
- Windows/macOS launchers and Word/WPS rendering were not tested on real systems.

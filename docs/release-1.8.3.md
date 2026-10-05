# v1.8.3 — Draft-resolution numbering hierarchy

Baseline: v1.8.2 plus the existing standalone-hosting commit. No sample names, private text, paths or document bytes are included. Other document types retain their existing numbering behavior.

## Correction

The old pipeline treated a marker's appearance as its hierarchy and protected incorrect notation as if it were authoritative. A neatly formatted Chinese DR could consequently retain `(a) → （一） → （甲）` and flatten parent/child indentation. Numbering correctness was not proved by text-preservation or engine-parity tests.

`shared/dr-numbering-policy.json` records handbook pages 42–45: Chinese `第X条 → （一） → （子） → （甲）`, English `1. → (a) → (i) → i.`. Both engines resolve explicit article boundaries, parent colons, sibling series and native-list identities before punctuation. They preserve ordinal values, jumps, list membership, starts/restarts and body cross-references. Missing committee-subject lines no longer cause Python to classify an explicit Chinese article as preamble.

Manual markers are converted only in plain, unprotected paragraphs. The paragraph content guard independently checks ordinal equality and unchanged body wording. Native lists receive per-instance presentation overrides, never a global shared-abstract rewrite. The package guard independently reconstructs the allowed overrides and still rejects counter, relationship, resource and other protected changes. Native-level overrides are read on subsequent passes.

Conflicting series, absent parent evidence, manual-plus-native numbering, protected structures, reused list instances, composite/legal formats, excessive depth and Word's cyclic zodiac/stem limits produce review warnings instead of guessed repairs. Ambiguous markers and their parent colons remain visible on repeated processing. A marker that may be a typo is not silently renumbered. Step 03 remains available; regression automation does not populate it.

## Verification

Dedicated tests cover orderly but wrong notation, canonical sibling returns, jumps, independent native instances, starts, protected-counter tampering, English/manual extended notation, native cycle limits, absent subject lines and persistent ambiguity. The supplied original and previous generated file were processed locally by both engines and independently read back; private inputs remain outside the repository. Rendered pages are inspected locally using LibreOffice; that does not establish native Word/WPS pixel equality.

Node: 187 unit checks plus 2 rendered-HTML and 2 standalone-static checks passed. Python: 192 checks passed after rebuilding the shared offline assets. Production and offline/static builds passed. Independent full readback of the frozen 287-case corpus agrees across engines, and each engine is idempotent on that corpus. Against v1.8.2, 242 cases are entirely identical; the 45 changed DR cases contain 44 retained parent-colon differences and five extended-zodiac-indent differences (some within the same case). No other readback properties differ. The two newly supplied files agree across engines; the corrected document is rendered for local visual inspection.

Successful parsing is not a claim that every semantic hierarchy can be recovered: where an author reuses the same markers at different ranks without reliable evidence, manual confirmation is still necessary. The release receipt records the final repository and website publication results separately.

# GitHub source import — 2026-10-01

## Scope and provenance

Clean initial import of the stable v1.6.3 source snapshot, original source commit `e0731d76a220125d312ac1b042695408bebf77e3`.

The old repository history, author identity, Git credentials and deployment remotes are not imported. The original working application is unchanged. No license, public visibility or collaborator permission is added by this import.

## Changes made for source publication

- Expanded `.gitignore`; replaced README with complete installation, execution, test and limitation instructions.
- Added `.env.example` and an account-neutral `.openai/hosting.example.json`. The actual hosting configuration remains ignored.
- Declared the tested pnpm version in `package.json`, retaining the existing dependencies and lockfile.
- Replaced the QA renderer's private absolute path with `--renderer` / `MUNWORD_DOCX_RENDERER`; added optional Pillow requirements.
- Made the optional historical browser regression output directory portable and configurable. Its legacy assertions were not changed.
- Added architecture navigation and a read-only working-tree/index audit script.

All 123 other retained original files are byte-identical to the stable source snapshot, including both engines, UI, shared rules, tests, synthetic inputs, the dependency lockfile and platform launchers. Seventeen original generated/account-specific files are excluded: one actual hosting configuration, eleven generated DOCX outputs and five generated macOS signature files. The outputs can be regenerated; the source launcher remains included. Caches and build outputs created by validation are ignored.

## Sensitive-data checks

- Scanned all proposed source files for common credential/token/private-key patterns, literal credential assignments, credential-bearing URLs, private machine paths and personal email addresses.
- Inspected 176 XML/relationship parts inside the eleven synthetic DOCX fixtures, including core metadata. Their creator is the generic `python-docx`, not a real user.
- The fixtures share the same generic thumbnail; manually inspected that thumbnail, the public social-preview image and Windows icon. They contain no user document screenshots or credentials.
- No API Key, Token, password, Cookie or private key was found in the proposed import. An account-scoped hosting configuration and a private absolute QA path were removed from publication. No credential was entered into source or Git configuration.
- Existing public site URLs in compatibility/CORS settings are not credentials and are retained to avoid runtime changes.

Automated pattern checks are heuristic, not a proof that every possible secret can be recognized. The exact staged objects are rescanned before the initial commit. True private reference documents and the academic-standard PDF are not included. Future contributors must repeat the check before publishing new fixtures.

## Validation performed in a separate fresh source directory

- Frozen Node dependency installation from the committed lockfile: passed.
- Python 3.12 fresh virtual environment installation from existing requirements: passed; `pip check` passed.
- Node unit tests: 69 passed.
- Python tests: 83 passed.
- Production build and rendered HTML tests: passed (2 HTML tests).
- TypeScript checking and ESLint: passed. The local Wrangler runtime requires permission to listen on loopback in a restricted sandbox.
- Local UI, docs and GET health endpoints: HTTP 200 through FastAPI's test client; health reports version 1.6.3 and six pipelines.
- All eleven acceptance outputs regenerated without rewriting the committed inputs; generated outputs remain ignored.
- Stable-source byte comparison confirms that no production code or layout behavior was changed by this publication work.

These checks do not constitute a new pixel-level layout audit or a real-device Windows installer acceptance. GitHub publication and remote SHA/tree verification are reported separately when completed.

# Third party components

Munword's own authorization is unchanged. No source from the noncommercial
docformat-gui or AGPL CrispTranslator projects was copied into this release.
Their design ideas informed the analysis only; new diagnostics and CLI code
use Munword's existing models, rules and protection mechanisms.

## Browser additions

- **docx-preview 0.4.0** — https://github.com/VolodymyrBaydalka/docxjs,
  Apache License 2.0. See the installed package's LICENSE.
- **docxtemplater 3.71.0** — https://github.com/open-xml-templating/docxtemplater,
  used under its MIT licensing option. Paid modules are not included.
- **PizZip 3.3.0** — https://github.com/open-xml-templating/pizzip.
  See LICENSE.markdown for its MIT option and original ZIP-code notices.
- **JSZip**, a transitive preview dependency, is used under its MIT option.
  Existing dependencies and their licenses remain listed in the lockfile.

`pnpm build:local-tools` includes library notices and copies complete licenses
to `public/licenses/`. Desktop ZIPs include those files. Do not strip these
notices when redistributing the generated bundle.

## Optional visual QA

Gotenberg is a separately run MIT-licensed service; its container includes
LibreOffice and other components with their own licenses. This release does
not embed or redistribute that container in the website or desktop ZIP.
Pillow and pypdf are optional development/QA dependencies, not application
runtime dependencies. Their installed licenses apply independently.

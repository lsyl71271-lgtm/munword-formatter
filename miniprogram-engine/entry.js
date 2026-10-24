// Everything the mini program pages call, straight from the shared engine in app/.
// Bundled into miniprogram/lib/munword-engine.js by miniprogram-engine/build.mjs.
export { parseDocxInBrowser, formatDocxInBrowser, isTreaty } from "../app/docx-browser.ts";
export { generateFromTemplate } from "../app/template-generator.ts";
export { buildDiagnosticReport } from "../app/diagnostics.ts";
export { COUNTRY_DATA_DATE, countryWarnings, planCountries, splitCountryNames } from "../app/countries.ts";
export { MAX_UPLOAD } from "../app/docx-safety.ts";
export { version } from "../package.json";

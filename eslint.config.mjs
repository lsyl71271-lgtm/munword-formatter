import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "worker-configuration.d.ts",
    ".cache/**",
    "output/**",
    "outputs/**",
    "qa/**",
    "public/studio-tools.js",
    "public/local-app.js",
    "static-site/**",
    ".static-site-*/**",
  ]),
]);

export default eslintConfig;

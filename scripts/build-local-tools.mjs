import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
await build({ entryPoints: ["local_web/studio-tools.ts"], outfile: "public/studio-tools.js", bundle: true, minify: true, format: "iife", platform: "browser", target: ["es2022"], legalComments: "inline" });
await mkdir("public/licenses", { recursive: true });
for (const [name, source] of Object.entries({ "docx-preview": "node_modules/docx-preview/LICENSE", "docxtemplater": "node_modules/docxtemplater/LICENSE.md", "pizzip": "node_modules/pizzip/LICENSE.markdown" })) {
  await copyFile(source, `public/licenses/${name}.txt`);
}
for (const [owner, dependency, license] of [["docx-preview", "jszip", "LICENSE.markdown"], ["docxtemplater", "@xmldom/xmldom", "LICENSE"]]) {
  const require = createRequire(import.meta.resolve(owner));
  const directory = path.dirname(require.resolve(`${dependency}/package.json`));
  await copyFile(path.join(directory, license), `public/licenses/${dependency.replace("/", "-")}.txt`);
}
await copyFile("node_modules/fflate/LICENSE", "public/licenses/fflate.txt");

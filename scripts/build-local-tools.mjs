import { build } from "esbuild";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
await build({ entryPoints: ["local_web/studio-tools.ts"], outfile: "public/studio-tools.js", bundle: true, minify: true, format: "iife", platform: "browser", target: ["es2022"], legalComments: "inline" });
await build({ entryPoints: ["local_web/main.tsx"], outfile: "public/local-app.js", bundle: true, minify: true, charset: "utf8", format: "iife", platform: "browser", target: ["es2022"], jsx: "automatic", legalComments: "inline", define: { "process.env.NODE_ENV": '"production"', "process.env.NEXT_PUBLIC_API_URL": '""' } });
// Compile the SAME global stylesheet (including Tailwind's reset/utilities).
// PostCSS is supplied by the pinned Tailwind plugin, not a system installation.
const requirePostcss = createRequire(import.meta.resolve("@tailwindcss/postcss"));
const postcss = requirePostcss("postcss"), tailwind = (await import("@tailwindcss/postcss")).default;
const styles = await postcss([tailwind()]).process(await readFile("app/globals.css", "utf8"), { from: path.resolve("app/globals.css") });
await writeFile("public/local-styles.css", styles.css);
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
for (const name of ["react", "react-dom"]) await copyFile(`node_modules/${name}/LICENSE`, `public/licenses/${name}.txt`);

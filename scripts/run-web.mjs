import { spawnSync } from "node:child_process";
const action = process.argv[2];
if (!["dev", "build", "start"].includes(action)) throw new Error("Expected dev, build or start");
const result = spawnSync(process.execPath, ["node_modules/vinext/dist/cli.js", action, ...process.argv.slice(3)], {
  stdio: "inherit", env: { ...process.env, WRANGLER_LOG_PATH: ".wrangler/wrangler.log" },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);

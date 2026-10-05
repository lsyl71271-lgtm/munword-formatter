// Same checks on POSIX and Windows; no shell-specific environment assignment.
import { spawnSync } from "node:child_process";
for (const args of [
  ["node_modules/wrangler/bin/wrangler.js", "types", "--config", "dist/server/wrangler.json", "worker-configuration.d.ts", "--include-env", "false"],
  ["node_modules/typescript/bin/tsc", "--noEmit", "--incremental", "false"],
]) {
  const result = spawnSync(process.execPath, args, { stdio: "inherit", env: { ...process.env, WRANGLER_LOG_PATH: ".wrangler/wrangler.log" } });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

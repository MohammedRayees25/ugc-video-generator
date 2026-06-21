/**
 * Direct pipeline QA — bypasses Claude API entirely.
 * Tests generateUgcVideo() with 5 mock product scenarios.
 *
 * Run: node --experimental-vm-modules scripts/qa-pipeline.mjs
 * Or:  node -r @swc-node/register scripts/qa-pipeline.mjs
 *
 * Uses tsx via: npx tsx scripts/qa-pipeline.mjs
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

console.log("=".repeat(70));
console.log("UGC Video Generator — End-to-End Pipeline QA");
console.log("=".repeat(70));
console.log();

// Run the actual test via tsx so TypeScript modules work
const result = spawnSync(
  "npx",
  ["tsx", path.join(__dirname, "qa-pipeline.ts")],
  {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env },
    timeout: 5 * 60 * 1000,
  }
);

process.exit(result.status ?? 1);

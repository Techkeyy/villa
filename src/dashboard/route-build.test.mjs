import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import os from "node:os";

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("dashboard build emits an explainer-first root and workspace-first /app route", async () => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), "villa-dashboard-build-"));
  try {
    await run(process.execPath, ["scripts/dashboard-build.mjs"], { cwd: root, windowsHide: true, env: { ...process.env, VILLA_DASHBOARD_OUTPUT: output } });
    const landing = await fs.readFile(path.join(output, "index.html"), "utf8");
    const app = await fs.readFile(path.join(output, "app", "index.html"), "utf8");
    assert.match(landing, /<body data-route="landing">/);
    assert.match(app, /<body data-route="app">/);
    assert.match(app, /<section class="page page-landing"[^>]* hidden>/);
    assert.match(app, /<section class="page page-app"[^>]*>/);
    assert.doesNotMatch(app, /<section class="page page-app"[^>]* hidden>/);
    assert.match(app, /MY LIQUIDITY/);
    assert.match(app, /<section class="page page-landing"[^>]* hidden>/);
    await fs.access(path.join(output, "villa-account-artifact.json"));
    await fs.access(path.join(output, "villa-account-artifact-v1.json"));
    const vercel = JSON.parse(await fs.readFile(path.join(root, "vercel.json"), "utf8"));
    assert.deepEqual(vercel.rewrites, [
      { source: "/app", destination: "/app/index.html" },
      { source: "/app/", destination: "/app/index.html" },
      { source: "/proof", destination: "/proof/index.html" },
      { source: "/proof/", destination: "/proof/index.html" },
    ]);
  } finally {
    await fs.rm(output, { recursive: true, force: true });
  }
});

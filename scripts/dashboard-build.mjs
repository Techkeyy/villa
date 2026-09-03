import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "dashboard");
const output = path.join(root, "dist", "dashboard");

function routeShell(html, route) {
  const routed = html.replace("<body>", `<body data-route="${route}">`);
  return routed.replace(/(<section\b[^>]*\bdata-page="([^"]+)"[^>]*)>/g, (_match, open, page) => {
    const clean = open.replace(/\s+hidden\b/g, "");
    return `${clean}${page === route ? "" : " hidden"}>`;
  });
}

await fs.rm(output, { recursive: true, force: true });
await fs.mkdir(output, { recursive: true });
const sourceHtml = await fs.readFile(path.join(source, "index.html"), "utf8");
await fs.writeFile(path.join(output, "index.html"), routeShell(sourceHtml, "landing"));
for (const name of ["styles.css", "app.mjs", "control-client.mjs", "account-client.mjs", "account-config.mjs", "account-journey.mjs", "account-readiness.mjs", "liquidity-flow.mjs", "authorization-flow.mjs", "villa-account-artifact.json", "favicon.svg"]) await fs.copyFile(path.join(source, name), path.join(output, name));
await fs.copyFile(path.join(root, "src", "dashboard", "presenter.mjs"), path.join(output, "presenter.mjs"));
for (const route of ["app", "proof"]) {
  await fs.mkdir(path.join(output, route), { recursive: true });
  await fs.writeFile(path.join(output, route, "index.html"), routeShell(sourceHtml, route));
}

const html = await fs.readFile(path.join(output, "index.html"), "utf8");
const appHtml = await fs.readFile(path.join(output, "app", "index.html"), "utf8");
const proofHtml = await fs.readFile(path.join(output, "proof", "index.html"), "utf8");
for (const name of ["app.mjs", "control-client.mjs", "account-client.mjs", "account-config.mjs", "account-journey.mjs", "account-readiness.mjs", "liquidity-flow.mjs", "authorization-flow.mjs", "villa-account-artifact.json"]) await fs.access(path.join(output, name));
const required = ["/styles.css", "/app.mjs", "/favicon.svg", "VILLA", "/app", "/proof", "MY LIQUIDITY", "Add liquidity", "Authorize VILLA", "View verified replay"];
const missing = required.filter((needle) => !html.includes(needle));
if (missing.length) throw new Error(`dashboard build missing required markers: ${missing.join(", ")}`);
if (!html.includes('<body data-route="landing">') || !appHtml.includes('<body data-route="app">') || !proofHtml.includes('<body data-route="proof">')) throw new Error("dashboard build route markers are missing");
if (!/<section class="page page-landing"[^>]* hidden>/.test(appHtml) || /<section class="page page-app"[^>]* hidden>/.test(appHtml)) throw new Error("dashboard app route is not workspace-first");
if (!/<section class="page page-landing"[^>]*>/.test(html) || !/<section class="page page-app"[^>]* hidden>/.test(html)) throw new Error("dashboard landing route is not explainer-first");
console.log(`Dashboard build ready: ${path.relative(root, output)}`);

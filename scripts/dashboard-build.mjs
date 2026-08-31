import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "dashboard");
const output = path.join(root, "dist", "dashboard");

await fs.rm(output, { recursive: true, force: true });
await fs.mkdir(output, { recursive: true });
for (const name of ["index.html", "styles.css", "app.mjs", "account-client.mjs", "account-config.mjs", "account-journey.mjs", "account-readiness.mjs", "liquidity-flow.mjs", "authorization-flow.mjs", "villa-account-artifact.json", "favicon.svg"]) await fs.copyFile(path.join(source, name), path.join(output, name));
await fs.copyFile(path.join(root, "src", "dashboard", "presenter.mjs"), path.join(output, "presenter.mjs"));
for (const route of ["app", "proof"]) {
  await fs.mkdir(path.join(output, route), { recursive: true });
  await fs.copyFile(path.join(source, "index.html"), path.join(output, route, "index.html"));
}

const html = await fs.readFile(path.join(output, "index.html"), "utf8");
for (const name of ["app.mjs", "account-client.mjs", "account-config.mjs", "account-journey.mjs", "account-readiness.mjs", "liquidity-flow.mjs", "authorization-flow.mjs", "villa-account-artifact.json"]) await fs.access(path.join(output, name));
const required = ["/styles.css", "/app.mjs", "/favicon.svg", "VILLA", "/app", "/proof", "MY LIQUIDITY", "Add liquidity", "Authorize VILLA", "View verified replay"];
const missing = required.filter((needle) => !html.includes(needle));
if (missing.length) throw new Error(`dashboard build missing required markers: ${missing.join(", ")}`);
console.log(`Dashboard build ready: ${path.relative(root, output)}`);

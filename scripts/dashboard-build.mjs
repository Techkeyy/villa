import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "dashboard");
const output = path.join(root, "dist", "dashboard");

await fs.rm(output, { recursive: true, force: true });
await fs.mkdir(output, { recursive: true });
for (const name of ["index.html", "styles.css", "app.mjs", "favicon.svg"]) await fs.copyFile(path.join(source, name), path.join(output, name));
await fs.copyFile(path.join(root, "src", "dashboard", "presenter.mjs"), path.join(output, "presenter.mjs"));

const html = await fs.readFile(path.join(output, "index.html"), "utf8");
const required = ["/styles.css", "/app.mjs", "/favicon.svg", "VILLA", "PRODUCT EXPLAINER", "Enter operator console", "How it works", "REPLAY", "PNL_UNAVAILABLE"];
const missing = required.filter((needle) => !html.includes(needle));
if (missing.length) throw new Error(`dashboard build missing required markers: ${missing.join(", ")}`);
console.log(`Dashboard build ready: ${path.relative(root, output)}`);

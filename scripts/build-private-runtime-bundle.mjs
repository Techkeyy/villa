/**
 * Build the immutable, signer-bearing UAT runtime bundle.
 *
 * The output contains only the transitive local module graph for the three
 * private entrypoints, the locked production dependency metadata, and the
 * reviewed root-owned installation specifications. It never reads .env,
 * credentials, journals, or private keys.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  PRIVATE_DEPLOYMENT_FILES,
  PRIVATE_DEPLOYMENT_MODES,
  PRIVATE_RUNTIME_ENTRIES,
} from "./private-runtime-deployment.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const POSIX = (value) => value.split(path.sep).join("/");

function fail(message) {
  throw new Error(`PRIVATE_BUNDLE: ${message}`);
}

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

function assertCleanTrackedTree() {
  try { execFileSync("git", ["diff", "--quiet", "HEAD"], { cwd: ROOT, stdio: "ignore" }); } catch { fail("tracked working tree is not clean"); }
  try { execFileSync("git", ["diff", "--cached", "--quiet"], { cwd: ROOT, stdio: "ignore" }); } catch { fail("index contains uncommitted changes"); }
}

function packageName(specifier) {
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/")[0];
}

function localFile(specifier, importer, { optional = false } = {}) {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(importer), specifier);
  const candidates = [base, `${base}.mjs`, `${base}.js`, `${base}.json`, path.join(base, "index.mjs"), path.join(base, "index.js")];
  const file = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (!file && optional) return null;
  if (!file) fail(`unresolved local import ${specifier} from ${POSIX(path.relative(ROOT, importer))}`);
  const relative = path.relative(ROOT, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) fail(`local import escapes repository: ${specifier}`);
  return file;
}

function importSpecifiers(source) {
  const result = new Map();
  const add = (specifier, optional = false) => {
    result.set(specifier, (result.get(specifier) ?? false) && optional);
  };
  const patterns = [
    { pattern: /\b(?:import|export)\s+(?:[^"'`]*?\sfrom\s+)?["']([^"']+)["']/g, optional: false },
    { pattern: /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, optional: false },
    { pattern: /\bnew\s+URL\(\s*["'](\.{1,2}\/[^"']+)["']\s*,\s*import\.meta\.url\s*\)/g, optional: true },
  ];
  for (const { pattern, optional } of patterns) {
    for (const match of source.matchAll(pattern)) add(match[1], optional);
  }
  return [...result].map(([specifier, optional]) => ({ specifier, optional }));
}

function digest(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function parseArgs() {
  const outputArg = process.argv.slice(2).find((arg) => arg.startsWith("--output="));
  const output = outputArg ? outputArg.slice("--output=".length) : path.join(ROOT, ".scratch", `private-runtime-bundle-${git(["rev-parse", "--short=12", "HEAD"])}`);
  return path.resolve(ROOT, output);
}

assertCleanTrackedTree();
const output = parseArgs();
if (fs.existsSync(output)) fail(`output already exists: ${POSIX(path.relative(ROOT, output))}`);
fs.mkdirSync(output, { recursive: true, mode: 0o755 });

const discovered = new Set();
const external = new Set();
const queue = PRIVATE_RUNTIME_ENTRIES.map((entry) => path.resolve(ROOT, entry));
while (queue.length > 0) {
  const file = queue.shift();
  if (discovered.has(file)) continue;
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) fail(`entry does not exist: ${POSIX(path.relative(ROOT, file))}`);
  discovered.add(file);
  for (const { specifier, optional } of importSpecifiers(fs.readFileSync(file, "utf8"))) {
    if (specifier.startsWith("node:")) continue;
    const imported = localFile(specifier, file, { optional });
    if (imported) queue.push(imported);
    else external.add(packageName(specifier));
  }
}

for (const metadata of ["package.json", "package-lock.json"]) {
  const source = path.join(ROOT, metadata);
  if (!fs.existsSync(source)) fail(`required dependency metadata is missing: ${metadata}`);
  discovered.add(source);
}

const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));
const dependencies = Object.fromEntries([...external].sort().map((name) => {
  const locked = lock.packages?.[`node_modules/${name}`]?.version;
  if (!locked) fail(`external runtime import is not locked: ${name}`);
  return [name, { requested: packageJson.dependencies?.[name] ?? null, locked }];
}));

for (const file of discovered) {
  const relative = POSIX(path.relative(ROOT, file));
  const destination = path.join(output, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 });
  fs.copyFileSync(file, destination);
  fs.chmodSync(destination, 0o644);
}

for (const [relative, content] of Object.entries(PRIVATE_DEPLOYMENT_FILES)) {
  const destination = path.join(output, "deployment", relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 });
  fs.writeFileSync(destination, content, { encoding: "utf8", mode: PRIVATE_DEPLOYMENT_MODES[relative] });
  fs.chmodSync(destination, PRIVATE_DEPLOYMENT_MODES[relative]);
}

const sourceCommit = git(["rev-parse", "HEAD"]);
const files = [];
function listFiles(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) listFiles(file);
    else if (entry.name !== "SHA256SUMS" && entry.name !== "bundle-manifest.json") files.push(POSIX(path.relative(output, file)));
  }
}
listFiles(output);
files.sort();
const manifest = {
  format: "villa-private-runtime-bundle-v1",
  sourceCommit,
  entries: [...PRIVATE_RUNTIME_ENTRIES],
  localFiles: [...discovered].map((file) => POSIX(path.relative(ROOT, file))).sort(),
  externalDependencies: dependencies,
  files: Object.fromEntries(files.map((file) => [file, digest(path.join(output, file))])),
};
fs.writeFileSync(path.join(output, "bundle-manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o644 });
fs.chmodSync(path.join(output, "bundle-manifest.json"), 0o644);
const checks = ["bundle-manifest.json", ...files].sort().map((file) => `${digest(path.join(output, file))}  ${file}`);
fs.writeFileSync(path.join(output, "SHA256SUMS"), checks.join("\n") + "\n", { mode: 0o644 });
fs.chmodSync(path.join(output, "SHA256SUMS"), 0o644);

console.log(JSON.stringify({ output, sourceCommit, localFileCount: discovered.size, externalDependencies: dependencies, fileCount: checks.length }, null, 2));

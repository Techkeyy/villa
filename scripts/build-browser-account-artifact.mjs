import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const solc = require("solc");

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(root, "contracts", "VillaAccount.sol");
const artifactPath = path.join(root, "dashboard", "villa-account-artifact.json");

const source = await fs.readFile(sourcePath, "utf8");
const compilerInput = {
  language: "Solidity",
  sources: { "contracts/VillaAccount.sol": { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: "shanghai",
    outputSelection: {
      "contracts/VillaAccount.sol": {
        VillaAccount: ["abi", "evm.bytecode.object", "evm.deployedBytecode.object", "evm.deployedBytecode.immutableReferences"],
      },
    },
  },
};

const compilerOutputJson = solc.compile(JSON.stringify(compilerInput));
const compilerOutput = JSON.parse(compilerOutputJson);
const compilerErrors = (compilerOutput.errors || []).filter((entry) => entry.severity === "error");
if (compilerErrors.length) throw new Error(compilerErrors.map((entry) => entry.formattedMessage || entry.message).join("\n"));
const compiled = compilerOutput.contracts?.["contracts/VillaAccount.sol"]?.VillaAccount;
if (!compiled?.evm?.bytecode?.object || !compiled.evm.deployedBytecode?.object) throw new Error("solcjs did not return VillaAccount bytecode");
const creationBytecode = `0x${compiled.evm.bytecode.object}`.toLowerCase();
const runtimeBytecode = `0x${compiled.evm.deployedBytecode.object}`.toLowerCase();
const runtimeImmutableReferences = Object.values(compiled.evm.deployedBytecode.immutableReferences || {})
  .flat()
  .map(({ start, length }) => ({ start, length }))
  .sort((left, right) => left.start - right.start);
if (!runtimeImmutableReferences.length) throw new Error("solcjs did not return immutable runtime references");

let sourceCommit = "";
try {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root });
  sourceCommit = stdout.trim();
} catch {
  sourceCommit = "local";
}

const artifact = {
  schema: "villa-browser-account-artifact-v2",
  contract: "VillaAccount",
  accountVersion: 2,
  network: "Somnia Shannon",
  chainId: 50312,
  sourceSha256: crypto.createHash("sha256").update(source).digest("hex"),
  sourceCommit,
  compiler: `solc ${solc.version()} optimized`,
  compilerSettings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "shanghai" },
  creationBytecode,
  runtimeBytecode,
  runtimeImmutableReferences,
  abi: compiled.abi,
};
await fs.writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
console.log(`Browser account artifact ready: ${path.relative(root, artifactPath)}`);
console.log(`Runtime identity bytes: ${(runtimeBytecode.length - 2) / 2}`);
console.log(`Immutable reference ranges: ${runtimeImmutableReferences.length}`);

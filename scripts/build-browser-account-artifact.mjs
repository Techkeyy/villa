import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(root, "contracts", "VillaAccount.sol");
const artifactPath = path.join(root, "dashboard", "villa-account-artifact.json");

function runSolc(input) {
  return new Promise((resolve, reject) => {
    const child = execFile("npm.cmd", ["exec", "--yes", "--package=solc@0.8.30", "--", "solcjs", "--standard-json"], {
      cwd: root,
      shell: true,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`solcjs failed: ${stderr || error.message}`));
        return;
      }
      resolve(stdout);
    });
    child.stdin?.end(JSON.stringify(input));
  });
}

const source = await fs.readFile(sourcePath, "utf8");
const compilerInput = {
  language: "Solidity",
  sources: { "contracts/VillaAccount.sol": { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: {
      "contracts/VillaAccount.sol": {
        VillaAccount: ["abi", "evm.bytecode.object", "evm.deployedBytecode.object", "evm.deployedBytecode.immutableReferences"],
      },
    },
  },
};
const compilerStdout = await runSolc(compilerInput);
const jsonStart = compilerStdout.indexOf("{");
if (jsonStart < 0) throw new Error("solcjs returned no standard JSON output");
const compilerOutput = JSON.parse(compilerStdout.slice(jsonStart));
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

const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root });
const artifact = {
  schema: "villa-browser-account-artifact-v2",
  contract: "VillaAccount",
  network: "Somnia Shannon",
  chainId: 50312,
  sourceSha256: crypto.createHash("sha256").update(source).digest("hex"),
  sourceCommit: stdout.trim(),
  compiler: "solc 0.8.30 optimized",
  creationBytecode,
  runtimeBytecode,
  runtimeImmutableReferences,
  abi: compiled.abi,
};
await fs.writeFile(artifactPath, `${JSON.stringify(artifact)}\n`, "utf8");
console.log(`Browser account artifact ready: ${path.relative(root, artifactPath)}`);
console.log(`Runtime identity bytes: ${(runtimeBytecode.length - 2) / 2}`);
console.log(`Immutable reference ranges: ${runtimeImmutableReferences.length}`);

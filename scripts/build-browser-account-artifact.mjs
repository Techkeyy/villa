import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildRoot = path.join(root, ".scratch", "account-build");
const sourcePath = path.join(root, "contracts", "VillaAccount.sol");
const artifactPath = path.join(root, "dashboard", "villa-account-artifact.json");
const creationPath = path.join(buildRoot, "contracts_VillaAccount_sol_VillaAccount.bin");
const abiPath = path.join(buildRoot, "contracts_VillaAccount_sol_VillaAccount.abi");
const proofAccount = "0xe78bd09d6869e450e66a49d1d3beebbfa75fb0cd";
const rpcUrl = "https://dream-rpc.somnia.network";

const [source, creation, abiText] = await Promise.all([
  fs.readFile(sourcePath),
  fs.readFile(creationPath, "utf8"),
  fs.readFile(abiPath, "utf8"),
]);

const response = await fetch(rpcUrl, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [proofAccount, "latest"] }),
});
if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
const body = await response.json();
if (body.error) throw new Error(body.error.message || JSON.stringify(body.error));
const runtimeBytecode = String(body.result || "").toLowerCase();
if (!runtimeBytecode.startsWith("0x") || runtimeBytecode.length < 100) throw new Error("known Shannon account has no runtime bytecode");

const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root });
const artifact = {
  schema: "villa-browser-account-artifact-v1",
  contract: "VillaAccount",
  network: "Somnia Shannon",
  chainId: 50312,
  sourceSha256: crypto.createHash("sha256").update(source).digest("hex"),
  sourceCommit: stdout.trim(),
  compiler: "solc 0.8.30 optimized",
  creationBytecode: `0x${creation.trim()}`,
  runtimeBytecode,
  runtimeReferenceAccount: proofAccount,
  abi: JSON.parse(abiText),
};
await fs.writeFile(artifactPath, `${JSON.stringify(artifact)}\n`, "utf8");
console.log(`Browser account artifact ready: ${path.relative(root, artifactPath)}`);
console.log(`Runtime identity bytes: ${(runtimeBytecode.length - 2) / 2}`);

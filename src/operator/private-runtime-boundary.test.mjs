import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  PRIVATE_DEPLOYMENT_FILES,
  PRIVATE_DEPLOYMENT_MODES,
  PRIVATE_RUNTIME_ENTRIES,
  PRIVATE_RUNTIME_ROOT,
  PRIVATE_STATE_ROOT,
  STATUS_ROOT,
} from "../../scripts/private-runtime-deployment.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const sessionUnit = PRIVATE_DEPLOYMENT_FILES["etc/systemd/system/villa-engine-uat@.service"];
const settlementUnit = PRIVATE_DEPLOYMENT_FILES["etc/systemd/system/villa-engine-uat-settle@.service"];
const brokerUnit = PRIVATE_DEPLOYMENT_FILES["etc/systemd/system/villa-uat-broker.service"];
const wrapper = PRIVATE_DEPLOYMENT_FILES["usr/local/libexec/villa-uat-control"];

test("private services are pinned to the root-controlled runtime and private state", () => {
  for (const unit of [sessionUnit, settlementUnit]) {
    assert.match(unit, new RegExp(`WorkingDirectory=${PRIVATE_RUNTIME_ROOT}`));
    assert.match(unit, new RegExp(`ExecStart=/usr/bin/node ${PRIVATE_RUNTIME_ROOT}/`));
    assert.doesNotMatch(unit, /--jitless/);
    assert.match(unit, /User=villa-engine/);
    assert.match(unit, /Group=villa-engine/);
    assert.doesNotMatch(unit, /Group=villa\n/);
    assert.match(unit, /Environment=VILLA_UAT_PRIVATE_STATE_FILE=\/var\/lib\/villa-engine\/uat-%i\/session\.json/);
    assert.match(unit, /Environment=VILLA_UAT_STATUS_FILE=\/run\/villa-uat-status\/%i\.json/);
    assert.match(unit, /ConditionPathExists=\/run\/villa-uat-bindings\/%i\.env/);
    assert.match(unit, /EnvironmentFile=\/run\/villa-uat-bindings\/%i\.env/);
    assert.doesNotMatch(unit, /EnvironmentFile=-\/run\/villa-uat-bindings\//);
    assert.doesNotMatch(unit, /Environment=VILLA_ENGINE_OWNER=/);
    assert.doesNotMatch(unit, /Environment=VILLA_ENGINE_ACCOUNT=/);
    assert.match(unit, /StateDirectory=villa-engine\/uat-%i/);
    assert.match(unit, /UMask=0077/);
    assert.match(unit, /KillMode=mixed/);
    assert.match(unit, /KillSignal=SIGTERM/);
    assert.match(unit, /TimeoutStopSec=180/);
    assert.match(unit, /SendSIGKILL=no/);
    assert.match(unit, /NoNewPrivileges=true/);
    assert.match(unit, /ProtectSystem=strict/);
    assert.match(unit, /ProtectHome=true/);
    assert.match(unit, /PrivateTmp=true/);
    assert.match(unit, /PrivateDevices=true/);
    assert.match(unit, /RestrictNamespaces=true/);
    assert.doesNotMatch(unit, /MemoryDenyWriteExecute=true/);
    assert.match(unit, /CapabilityBoundingSet=\n/);
    assert.match(unit, /Environment=VILLA_EXECUTION_ENABLED=false/);
    assert.match(unit, /Environment=VILLA_UAT_EXECUTION_ENABLED=false/);
    assert.match(unit, /Environment=VILLA_ACCOUNT_EXECUTION_ENABLED=true/);
    assert.match(unit, new RegExp(`ReadWritePaths=${STATUS_ROOT} ${PRIVATE_STATE_ROOT}`));
    assert.doesNotMatch(unit, /\/opt\/villa-operator/);
  }
});

test("wrapper has no arbitrary command, service, or extra-argument surface", () => {
  assert.match(wrapper, /\[ "\$#" -eq 2 \]/);
  assert.match(wrapper, /start\|stop\|settle/);
  assert.match(wrapper, /uat-\[0-9\]\+-\[0-9a-f\]\{8\}/);
  assert.match(wrapper, /villa-engine-uat@\$\{session\}\.service/);
  assert.match(wrapper, /villa-engine-uat-settle@\$\{session\}\.service/);
  assert.doesNotMatch(wrapper, /sh -c|exec\s+\$|systemctl\s+\$[A-Za-z_]+/);
  assert.equal(PRIVATE_DEPLOYMENT_MODES["usr/local/libexec/villa-uat-control"], 0o755);
});

test("root broker is the only dynamic identity boundary", () => {
  assert.match(brokerUnit, /User=root/);
  assert.match(brokerUnit, /Group=villa/);
  assert.match(brokerUnit, /villa-uat-broker\.mjs/);
  assert.match(brokerUnit, /ReadWritePaths=\/run\/villa-uat-broker \/run\/villa-uat-bindings/);
  assert.match(brokerUnit, /InaccessiblePaths=\/etc\/villa-engine\.env/);
  assert.match(brokerUnit, /UnsetEnvironment=OPERATOR_PRIVATE_KEY TAKER_PRIVATE_KEY PRIVATE_KEY WALLET_SEED MNEMONIC CREDENTIALS_DIRECTORY/);
  assert.match(brokerUnit, /VILLA_ENGINE_OPERATOR=0xaf4ee6/);
  assert.doesNotMatch(brokerUnit, /OPERATOR_PRIVATE_KEY=/);
  assert.doesNotMatch(brokerUnit, /LoadCredential=|(?:^|\n)Environment=.*CREDENTIALS_DIRECTORY/);
});

test("private bundle entrypoints and specs contain no public-writable runtime path", () => {
  assert.deepEqual(PRIVATE_RUNTIME_ENTRIES, [
    "scripts/villa-uat-broker.mjs",
    "scripts/lp-account-session-service.mjs",
    "scripts/lp-account-session.mjs",
    "scripts/lp-account-settlement.mjs",
  ]);
  for (const entry of PRIVATE_RUNTIME_ENTRIES) {
    const source = fs.readFileSync(path.join(ROOT, entry), "utf8");
    assert.doesNotMatch(source, /\/opt\/villa-operator/);
  }
  assert.doesNotMatch(sessionUnit, /OPERATOR_PRIVATE_KEY=/);
  assert.doesNotMatch(settlementUnit, /OPERATOR_PRIVATE_KEY=/);
  assert.equal(PRIVATE_DEPLOYMENT_FILES["etc/sudoers.d/villa-uat-control"], undefined);
  assert.equal(PRIVATE_DEPLOYMENT_MODES["etc/sudoers.d/villa-uat-control"], undefined);
  const broker = fs.readFileSync(path.join(ROOT, "scripts/villa-uat-broker.mjs"), "utf8");
  assert.match(broker, /fs\.link\(temporary, bindingPath\(sessionId\)\)/);
  assert.doesNotMatch(broker, /fs\.rename\(/);
});

test("service stop forwards a typed product stop and waits for cleanup with observable stdio", () => {
  const service = fs.readFileSync(path.join(ROOT, "scripts/lp-account-session-service.mjs"), "utf8");
  const worker = fs.readFileSync(path.join(ROOT, "scripts/lp-account-session.mjs"), "utf8");
  assert.match(service, /worker = fork\(workerPath, \[\], \{ env: process\.env, stdio: \["ignore", "inherit", "inherit", "ipc"\] \}\)/);
  assert.match(service, /worker\.send\(\{ type: "stop", reason: "SERVICE_STOP" \}\)/);
  assert.match(service, /worker\.once\("exit"/);
  assert.match(worker, /process\.once\("SIGTERM"/);
  assert.match(worker, /await enqueue\(adapter\.cancelOrder/);
  assert.match(worker, /adapter\.burnCompleteSet/);
  assert.match(worker, /assessSessionSettlement/);
  assert.match(worker, /leaseStore\.release/);
});

test("account session validates dynamic positive collateral without historic magic amounts", () => {
  const worker = fs.readFileSync(path.join(ROOT, "scripts/lp-account-session.mjs"), "utf8");
  assert.doesNotMatch(worker, /1_002_000n/);
  assert.doesNotMatch(worker, /1002000n/);
  assert.match(worker, /if \(initialCollateralRaw <= 0n\) fail\("CAPITAL_INVALID"/);
  assert.match(worker, /if \(initialCollateralRaw > DEFAULT_PHASE_3B1_CAPS\.MAX_ACCOUNT_CAPITAL\) fail\("ACCOUNT_CAPITAL_CAP"/);
  assert.match(worker, /if \(mintAmountRaw > DEFAULT_PHASE_3B1_CAPS\.MAX_MINT_AMOUNT \|\| mintAmountRaw > identity\.maxOrderCollateral \|\| mintAmountRaw >= initialCollateralRaw\) fail\("MINT_CAP"/);
});

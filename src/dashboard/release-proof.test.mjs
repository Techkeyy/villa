import assert from "node:assert/strict";
import test from "node:test";
import { buildReplayEnvelope, REPLAY_SCENES } from "./replay.mjs";

const OWNER = "0xEFe0412781d3c1e7888b2DB9dEEcA3037542494d";
const ACCOUNT = "0x3A46446A30F945d390A41dAab0D390fBEf3d2cF2";
const OPERATOR = "0xaf4ee6C0c6Ff6337F4C4F07b87C8343dF73e8d37";
const MARKET = "0x" + "0".repeat(59) + "10a14";
const TRANSACTIONS = [
  "0x0389fac8ca7fe56bf6b2b96324fd69dd4799845926e920fe136627445171b972",
  "0xbb4e0d8b33259858dee23a50ce9bbd8dac60fe3b52a803fdce260a429ba89e6d",
  "0x80a3563c92ef35fedfa61af5ae099ce5804cf74e80158615a0e7852a36078735",
  "0xb645b3b0b9ffbc7cd72c1b40aaca0f2f344afe64fb2c6c1145fa56fe81f0b87e",
];

test("canonical replay is the verified account-bound release proof", () => {
  assert.deepEqual(REPLAY_SCENES, ["account-bound", "quote", "rollover", "settlement"]);
  const envelope = buildReplayEnvelope("account-bound");
  assert.equal(envelope.scene, "account-bound");
  assert.equal(envelope.snapshot.market.marketId, MARKET);
  assert.ok(envelope.evidence.facts.some((fact) => fact.includes(MARKET)));
  assert.equal(envelope.evidence.identity.owner, OWNER);
  assert.equal(envelope.evidence.identity.account, ACCOUNT);
  assert.equal(envelope.evidence.identity.operator, OPERATOR);
  assert.deepEqual(envelope.evidence.transactionLabels, ["MINT TX", "ORDER TX", "CANCEL TX", "BURN TX"]);
  assert.deepEqual(envelope.evidence.transactions, TRANSACTIONS);
  assert.equal(envelope.snapshot.accounting.tUSDC, "1002000");
  assert.equal(envelope.snapshot.inventory.currentMarketYes, "0");
  assert.equal(envelope.snapshot.inventory.currentMarketNo, "0");
  assert.equal(envelope.snapshot.system.state, "STOPPED");
  assert.equal(envelope.snapshot.risk.action, "HALT");
  assert.match(envelope.evidence.note, /approved account action/);
  assert.doesNotMatch(JSON.stringify(envelope), /profit|yield guarantee/i);
});

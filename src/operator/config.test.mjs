import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_OPERATOR_CONFIG, isExecutionEnabled, OperatorConfigError, operatorConfigToRunnerArgs, validateOperatorConfig } from "./config.mjs";

test("execution is disabled unless the flag is exactly true", () => {
  for (const value of [undefined, "", "false", "FALSE", "0", "yes", " true"]) {
    assert.equal(isExecutionEnabled({ VILLA_EXECUTION_ENABLED: value }), false);
  }
  assert.equal(isExecutionEnabled({ VILLA_EXECUTION_ENABLED: "true" }), true);
});

test("safe operator defaults are the verified BTC 5m bounds", () => {
  const config = validateOperatorConfig();
  assert.deepEqual(config, DEFAULT_OPERATOR_CONFIG);
  assert.deepEqual(operatorConfigToRunnerArgs(config), [
    "--confirm",
    "--max-session-sec=720",
    "--max-markets=3",
    "--max-orders=2",
    "--max-directional=0.001",
    "--max-allocation=0.001",
  ]);
});

test("operator config can only lower the bounded engine caps", () => {
  const config = validateOperatorConfig({
    capitalAllocationHuman: 0.002,
    maxDirectionalExposureHuman: 0.0005,
    maxRestingOrders: 1,
    maxMarkets: 1,
    maxSessionDurationSec: 120,
  });
  assert.equal(config.maxDirectionalExposureHuman, 0.0005);
  assert.equal(config.maxRestingOrders, 1);
  assert.equal(config.maxMarkets, 1);
  assert.equal(config.maxSessionDurationSec, 120);
});

test("operator config refuses unsupported series and unsafe caps", () => {
  assert.throws(() => validateOperatorConfig({ series: "ETH 5m" }), OperatorConfigError);
  assert.throws(() => validateOperatorConfig({ capitalAllocationHuman: 0.0001 }), OperatorConfigError);
  assert.throws(() => validateOperatorConfig({ maxDirectionalExposureHuman: 0.002 }), OperatorConfigError);
  assert.throws(() => validateOperatorConfig({ maxSessionDurationSec: 30 }), OperatorConfigError);
});

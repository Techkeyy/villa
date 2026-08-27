import {
  DEFAULT_ORCHESTRATOR_CONFIG,
  validateOrchestratorConfig,
} from "../orchestrator/index.mjs";

export const OPERATOR_CONFIG_VERSION = "villa-operator-config-v1";

/** Wet execution is opt-in. Every value except the literal string "true" is disabled. */
export function isExecutionEnabled(env = process.env) {
  return env?.VILLA_EXECUTION_ENABLED === "true";
}

export const DEFAULT_OPERATOR_CONFIG = Object.freeze({
  version: OPERATOR_CONFIG_VERSION,
  series: "BTC 5m",
  capitalAllocationHuman: 0.001,
  maxDirectionalExposureHuman: DEFAULT_ORCHESTRATOR_CONFIG.maxDirectionalExposureHuman,
  maxRestingOrders: DEFAULT_ORCHESTRATOR_CONFIG.maxRestingOrders,
  maxMarkets: DEFAULT_ORCHESTRATOR_CONFIG.maxMarkets,
  maxSessionDurationSec: DEFAULT_ORCHESTRATOR_CONFIG.maxSessionDurationSec,
});

export const OPERATOR_CONFIG_LIMITS = Object.freeze({
  minCapitalAllocationHuman: 0.001,
  maxCapitalAllocationHuman: DEFAULT_ORCHESTRATOR_CONFIG.maxCommittedCollateralHuman,
  maxDirectionalExposureHuman: DEFAULT_ORCHESTRATOR_CONFIG.maxDirectionalExposureHuman,
  maxRestingOrders: DEFAULT_ORCHESTRATOR_CONFIG.maxRestingOrders,
  maxMarkets: DEFAULT_ORCHESTRATOR_CONFIG.maxMarkets,
  minSessionDurationSec: 60,
  maxSessionDurationSec: DEFAULT_ORCHESTRATOR_CONFIG.maxSessionDurationSec,
});

export class OperatorConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OperatorConfigError";
    this.code = code;
  }
}

function finite(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new OperatorConfigError("CONFIG_INVALID", `${label} must be finite`);
  return parsed;
}

function bounded(value, label, minimum, maximum) {
  const parsed = finite(value, label);
  if (parsed < minimum || parsed > maximum) {
    throw new OperatorConfigError("CONFIG_INVALID", `${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function integer(value, label, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new OperatorConfigError("CONFIG_INVALID", `${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

/**
 * Validate the small operator-facing surface and map it to lower-only
 * orchestrator caps. The verified strategy and risk semantics stay intact.
 */
export function validateOperatorConfig(input = {}) {
  const supplied = { ...DEFAULT_OPERATOR_CONFIG, ...(input ?? {}) };
  if (supplied.version !== OPERATOR_CONFIG_VERSION) {
    throw new OperatorConfigError("CONFIG_INVALID", `unsupported operator config version ${supplied.version}`);
  }
  if (supplied.series !== DEFAULT_OPERATOR_CONFIG.series) {
    throw new OperatorConfigError("CONFIG_INVALID", "the MVP operator surface supports BTC 5m only");
  }
  const normalized = {
    version: OPERATOR_CONFIG_VERSION,
    series: DEFAULT_OPERATOR_CONFIG.series,
    capitalAllocationHuman: bounded(
      supplied.capitalAllocationHuman,
      "capitalAllocationHuman",
      OPERATOR_CONFIG_LIMITS.minCapitalAllocationHuman,
      OPERATOR_CONFIG_LIMITS.maxCapitalAllocationHuman,
    ),
    maxDirectionalExposureHuman: bounded(
      supplied.maxDirectionalExposureHuman,
      "maxDirectionalExposureHuman",
      0.000001,
      OPERATOR_CONFIG_LIMITS.maxDirectionalExposureHuman,
    ),
    maxRestingOrders: integer(supplied.maxRestingOrders, "maxRestingOrders", 1, OPERATOR_CONFIG_LIMITS.maxRestingOrders),
    maxMarkets: integer(supplied.maxMarkets, "maxMarkets", 1, OPERATOR_CONFIG_LIMITS.maxMarkets),
    maxSessionDurationSec: integer(
      supplied.maxSessionDurationSec,
      "maxSessionDurationSec",
      OPERATOR_CONFIG_LIMITS.minSessionDurationSec,
      OPERATOR_CONFIG_LIMITS.maxSessionDurationSec,
    ),
  };
  validateOrchestratorConfig({
    ...DEFAULT_ORCHESTRATOR_CONFIG,
    maxMarkets: normalized.maxMarkets,
    maxSessionDurationSec: normalized.maxSessionDurationSec,
    maxRestingOrders: normalized.maxRestingOrders,
    maxDirectionalExposureHuman: normalized.maxDirectionalExposureHuman,
    maxProvisionedCollateralHuman: Math.min(DEFAULT_ORCHESTRATOR_CONFIG.maxProvisionedCollateralHuman, normalized.capitalAllocationHuman),
    maxCommittedCollateralHuman: normalized.capitalAllocationHuman,
    maxTotalProvisionedCollateralHuman: normalized.capitalAllocationHuman,
  });
  return Object.freeze(normalized);
}

export function operatorConfigToRunnerArgs(config) {
  const validated = validateOperatorConfig(config);
  return [
    "--confirm",
    `--max-session-sec=${validated.maxSessionDurationSec}`,
    `--max-markets=${validated.maxMarkets}`,
    `--max-orders=${validated.maxRestingOrders}`,
    `--max-directional=${validated.maxDirectionalExposureHuman}`,
    `--max-allocation=${validated.capitalAllocationHuman}`,
  ];
}

export function safeOperatorConfig() {
  return validateOperatorConfig(DEFAULT_OPERATOR_CONFIG);
}

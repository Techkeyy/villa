/** Pure Phase 1 / V2 account-boundary policy mirror. It never performs chain I/O. */

export const ACCOUNT_ROLES = Object.freeze({ OWNER: "OWNER", OPERATOR: "OPERATOR", ATTACKER: "ATTACKER" });

export const OPERATOR_ACTIONS = Object.freeze([
  "prepareMarket",
  "operatorPlaceOrder",
  "operatorCancelOrder",
  "operatorReduceOrder",
  "operatorMintSet",
  "operatorBurnSet",
  "operatorRedeem",
  "operatorClaimVault",
]);

export const OWNER_ACTIONS = Object.freeze([
  "deposit",
  "withdraw",
  "transferOwnership",
  "setOperator",
  "revokeOperator",
  "setAutonomousTrading",
  "setOrderLimits",
  "setMarketApproval",
  "prepareMarket",
  "revokeMarketApprovals",
  "ownerClaimVault",
  "recoverUnsupportedToken",
]);

export function accountActionAllowed(role, action) {
  if (role === ACCOUNT_ROLES.OWNER) return OWNER_ACTIONS.includes(action);
  if (role === ACCOUNT_ROLES.OPERATOR) return OPERATOR_ACTIONS.includes(action);
  return false;
}

export function operatorOrderAllowed({
  autonomousTradingEnabled = true,
  marketPrepared,
  marketApproved,
  currentMarket,
  operatorSet,
  kind,
  orderType,
  price,
  quantity,
  oneCollateral,
  maxQuantity,
  maxCollateral
}) {
  const preparedOrApproved = marketPrepared !== undefined ? marketPrepared : (marketApproved ?? true);
  if (!operatorSet || !preparedOrApproved || !currentMarket || !autonomousTradingEnabled) return false;
  if (!Number.isInteger(kind) || kind < 0 || kind > 3) return false;
  if (!Number.isInteger(orderType) || orderType < 0 || orderType > 3) return false;
  if (!Number.isSafeInteger(price) || price <= 0 || price >= oneCollateral) return false;
  if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity > maxQuantity) return false;
  const collateralRequired = kind === 0
    ? Math.ceil((quantity * price) / oneCollateral)
    : kind === 2
      ? Math.ceil((quantity * (oneCollateral - price)) / oneCollateral)
      : 0;
  return collateralRequired <= maxCollateral;
}

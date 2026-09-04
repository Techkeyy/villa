// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title VILLA per-user Event Contract account V2
/// @notice A deliberately narrow account boundary for one LP wallet and one
///         VILLA automation operator with bounded autonomous market operation.
///         It is not a generic smart wallet.

interface IERC20VillaAccount {
    function allowance(address owner, address spender) external view returns (uint256);
}

interface IBinaryModuleVillaAccount {
    struct MarketRecord {
        uint256 oracleQuestionId;
        uint8 outcomeSlotCount;
        uint8 voidPolicy;
        address collateral;
        uint32 originOperatorId;
        bytes32 originVenueId;
        address oracleAdapter;
        address creator;
        address market;
        address pool;
        uint256 yesId;
        uint256 noId;
        uint64 tradingStart;
        uint64 expiry;
    }

    function markets(bytes32 marketId) external view returns (MarketRecord memory);

    function redeem(
        uint32 operatorId,
        bytes32 venueId,
        bytes32 marketId,
        uint8 outcomeIdx,
        uint256 amount
    ) external;
}

interface IBinaryPoolVillaAccount {
    struct BinaryPoolParams {
        address collateralToken;
        address market;
        address outcomeToken;
        uint256 yesId;
        uint256 noId;
        uint256 oneCollateral;
        uint256 setBacking;
        address feeRecipient;
        uint256 makerFeeBpsTimes1k;
        uint256 takerFeeBpsTimes1k;
        uint256 maxBuilderFeeBpsTimes1k;
        uint256 settlementFeeBpsTimes1k;
        address settlement;
        uint64 marketNonce;
        bool finalized;
    }

    function getBinaryPoolParams() external view returns (BinaryPoolParams memory);

    function placeBinaryOrder(
        uint8 kind,
        uint256 price,
        uint256 quantity,
        uint64 expireTimestampNs,
        uint8 orderType,
        uint8 selfMatchingOption,
        address builder,
        uint96 builderFeeBpsTimes1k,
        uint64 userData
    ) external payable returns (bool success, uint128 id);

    function cancelOrder(uint128 orderId) external;
    function reduceOrder(uint128 orderId, uint256 newQuantityRemaining) external;
    function mintSet(address yesTo, address noTo, uint256 amount) external;
    function burnSet(uint256 amount) external;
    function withdraw(address token, uint256 amount) external;
}

contract VillaAccount {
    error AmountZero();
    error CallerNotOwner();
    error CallerNotOperator();
    error AutonomousTradingDisabled();
    error InvalidAddress();
    error InvalidMarket();
    error MarketNotPrepared();
    error MarketNotApproved();
    error MarketNotCurrent();
    error OrderLimitExceeded();
    error ExposureLimitExceeded();
    error MintLimitExceeded();
    error InvalidOrder();
    error InvalidOutcome();
    error NativeNotAccepted();
    error UnsupportedToken();
    error Reentrancy();
    error TokenCallFailed();

    event Deposited(address indexed owner, uint256 amount);
    event Withdrawn(address indexed owner, uint256 amount);
    event OperatorUpdated(address indexed operator);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event AutonomousTradingUpdated(bool indexed enabled);
    event ExposureLimitsUpdated(uint256 maxAggregateExposure, uint256 maxMintExposure);
    event MarketPrepared(bytes32 indexed marketId, address indexed pool);
    event MarketApprovalUpdated(bytes32 indexed marketId, bool approved);
    event OrderPlaced(bytes32 indexed marketId, uint128 indexed orderId, uint8 kind, uint256 price, uint256 quantity);
    event OrderCancelled(bytes32 indexed marketId, uint128 indexed orderId);
    event OrderReduced(bytes32 indexed marketId, uint128 indexed orderId, uint256 quantityRemaining);
    event CompleteSetMinted(bytes32 indexed marketId, uint256 amount);
    event CompleteSetBurned(bytes32 indexed marketId, uint256 amount);
    event Redeemed(bytes32 indexed marketId, uint8 indexed outcomeIdx, uint256 amount);
    event VaultClaimed(bytes32 indexed marketId, uint256 amount);

    address public immutable collateralToken;
    address public immutable outcomeToken;
    address public immutable binaryModule;
    address public immutable binarySettlement;

    address public owner;
    address public operator;
    uint8 public constant accountVersion = 2;
    bool public autonomousTradingEnabled;
    uint256 public maxOrderQuantity;
    uint256 public maxOrderCollateral;
    uint256 public maxAggregateExposure;
    uint256 public maxMintExposure;
    uint256 public aggregateExposure;
    uint256 public mintExposure;

    mapping(bytes32 marketId => bool prepared) public preparedMarkets;
    uint256 private _entered;

    modifier onlyOwner() {
        if (msg.sender != owner) revert CallerNotOwner();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != operator || operator == address(0)) revert CallerNotOperator();
        _;
    }

    /// @dev Owner cleanup remains available after operator revocation. The
    ///      operator branch is deliberately limited to cleanup methods below.
    modifier onlyOwnerOrOperator() {
        if (msg.sender != owner && (msg.sender != operator || operator == address(0))) revert CallerNotOperator();
        _;
    }

    modifier nonReentrant() {
        if (_entered != 0) revert Reentrancy();
        _entered = 1;
        _;
        _entered = 0;
    }

    constructor(
        address owner_,
        address operator_,
        address collateralToken_,
        address outcomeToken_,
        address binaryModule_,
        address binarySettlement_,
        uint256 maxOrderQuantity_,
        uint256 maxOrderCollateral_,
        uint256 maxAggregateExposure_,
        uint256 maxMintExposure_
    ) {
        if (
            owner_ == address(0) ||
            collateralToken_ == address(0) ||
            outcomeToken_ == address(0) ||
            binaryModule_ == address(0) ||
            binarySettlement_ == address(0) ||
            maxOrderQuantity_ == 0 ||
            maxOrderCollateral_ == 0 ||
            maxAggregateExposure_ == 0 ||
            maxMintExposure_ == 0 ||
            maxOrderCollateral_ > maxAggregateExposure_ ||
            maxMintExposure_ > maxAggregateExposure_
        ) revert InvalidAddress();
        owner = owner_;
        operator = operator_;
        collateralToken = collateralToken_;
        outcomeToken = outcomeToken_;
        binaryModule = binaryModule_;
        binarySettlement = binarySettlement_;
        maxOrderQuantity = maxOrderQuantity_;
        maxOrderCollateral = maxOrderCollateral_;
        maxAggregateExposure = maxAggregateExposure_;
        maxMintExposure = maxMintExposure_;
        autonomousTradingEnabled = true;
        emit OwnershipTransferred(address(0), owner_);
        emit OperatorUpdated(operator_);
        emit AutonomousTradingUpdated(true);
        emit ExposureLimitsUpdated(maxAggregateExposure_, maxMintExposure_);
    }

    receive() external payable {
        revert NativeNotAccepted();
    }

    fallback() external payable {
        revert NativeNotAccepted();
    }

    /// @notice Owner-funded collateral entry point. The owner approves this account first.
    function deposit(uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert AmountZero();
        _safeCall(
            collateralToken,
            abi.encodeWithSignature("transferFrom(address,address,uint256)", owner, address(this), amount)
        );
        emit Deposited(owner, amount);
    }

    /// @notice Withdraw only to the current owner. There is no destination parameter.
    function withdraw(uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert AmountZero();
        _safeCall(collateralToken, abi.encodeWithSignature("transfer(address,uint256)", owner, amount));
        emit Withdrawn(owner, amount);
    }

    function transferOwnership(address newOwner) external onlyOwner nonReentrant {
        if (newOwner == address(0)) revert InvalidAddress();
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function setOperator(address newOperator) external onlyOwner nonReentrant {
        operator = newOperator;
        emit OperatorUpdated(newOperator);
    }

    function revokeOperator() external onlyOwner nonReentrant {
        operator = address(0);
        autonomousTradingEnabled = false;
        emit OperatorUpdated(address(0));
        emit AutonomousTradingUpdated(false);
    }

    function setAutonomousTrading(bool enabled) external onlyOwner nonReentrant {
        autonomousTradingEnabled = enabled;
        emit AutonomousTradingUpdated(enabled);
    }

    function setOrderLimits(uint256 maxQuantity, uint256 maxCollateral) external onlyOwner nonReentrant {
        if (maxQuantity == 0 || maxCollateral == 0) revert AmountZero();
        if (maxCollateral > maxAggregateExposure) revert OrderLimitExceeded();
        maxOrderQuantity = maxQuantity;
        maxOrderCollateral = maxCollateral;
    }

    /// @notice Owner-set lifetime risk budgets for the operator. These
    ///         counters never decrease during the account lifetime, so a
    ///         compromised operator cannot recycle exposure through fills,
    ///         burns, redemptions, or market rollover.
    function setRiskLimits(uint256 maxAggregateExposure_, uint256 maxMintExposure_)
        external
        onlyOwner
        nonReentrant
    {
        if (
            maxAggregateExposure_ == 0 ||
            maxMintExposure_ == 0 ||
            maxMintExposure_ > maxAggregateExposure_ ||
            maxOrderCollateral > maxAggregateExposure_
        ) revert OrderLimitExceeded();
        maxAggregateExposure = maxAggregateExposure_;
        maxMintExposure = maxMintExposure_;
        emit ExposureLimitsUpdated(maxAggregateExposure_, maxMintExposure_);
    }

    /// @notice Backwards compatibility alias for preparedMarkets.
    function approvedMarkets(bytes32 marketId) external view returns (bool) {
        return preparedMarkets[marketId];
    }

    /// @notice Backwards compatibility setter.
    function setMarketApproval(bytes32 marketId, bool approved) external onlyOwner nonReentrant {
        if (marketId == bytes32(0)) revert InvalidMarket();
        preparedMarkets[marketId] = approved;
        emit MarketApprovalUpdated(marketId, approved);
    }

    /// @notice Autonomous market preparation.
    ///         Callable by owner OR operator (when autonomous trading is enabled).
    function prepareMarket(bytes32 marketId) public nonReentrant {
        if (msg.sender != owner) {
            if (msg.sender != operator || operator == address(0)) revert CallerNotOperator();
            if (!autonomousTradingEnabled) revert AutonomousTradingDisabled();
        }
        _prepareMarket(marketId);
    }

    /// @notice Remove protocol approvals for one market and its fixed settlement routes.
    function revokeMarketApprovals(bytes32 marketId) external onlyOwner nonReentrant {
        address pool = _recordPool(marketId);
        if (pool == address(0)) revert InvalidMarket();
        preparedMarkets[marketId] = false;
        _checkPoolAssetWiring(marketId, pool);
        _setOutcomeOperator(pool, false);
        _setOutcomeOperator(binaryModule, false);
        _setOutcomeOperator(binarySettlement, false);
        _safeCall(collateralToken, abi.encodeWithSignature("approve(address,uint256)", pool, 0));
    }

    function operatorPlaceOrder(
        bytes32 marketId,
        uint8 kind,
        uint256 price,
        uint256 quantity,
        uint64 expireTimestampNs,
        uint8 orderType,
        uint64 userData
    ) external onlyOperator nonReentrant returns (bool success, uint128 orderId) {
        if (!autonomousTradingEnabled) revert AutonomousTradingDisabled();
        (address pool, uint256 oneCollateral) = _currentPoolAndUnit(marketId);
        if (kind > 3 || price == 0 || price >= oneCollateral || quantity == 0 || quantity > maxOrderQuantity) {
            revert InvalidOrder();
        }
        if (orderType > 3) revert InvalidOrder();

        uint256 collateralRequired;
        if (kind == 0) {
            collateralRequired = _ceilDiv(quantity * price, oneCollateral);
        } else if (kind == 2) {
            collateralRequired = _ceilDiv(quantity * (oneCollateral - price), oneCollateral);
        }
        if (collateralRequired > maxOrderCollateral) revert OrderLimitExceeded();
        _consumeExposure(collateralRequired, false);
        if (collateralRequired != 0) _approveExact(pool, collateralRequired);

        (success, orderId) = IBinaryPoolVillaAccount(pool).placeBinaryOrder(
            kind,
            price,
            quantity,
            expireTimestampNs,
            orderType,
            0,
            address(0),
            0,
            userData
        );
        if (collateralRequired != 0) _safeCall(collateralToken, abi.encodeWithSignature("approve(address,uint256)", pool, 0));
        emit OrderPlaced(marketId, orderId, kind, price, quantity);
    }

    function operatorCancelOrder(bytes32 marketId, uint128 orderId) external onlyOwnerOrOperator nonReentrant {
        address pool = _recordPool(marketId);
        if (pool == address(0)) revert InvalidMarket();
        _checkPoolAssetWiring(marketId, pool);
        IBinaryPoolVillaAccount(pool).cancelOrder(orderId);
        emit OrderCancelled(marketId, orderId);
    }

    function operatorReduceOrder(bytes32 marketId, uint128 orderId, uint256 newQuantityRemaining)
        external
        onlyOwnerOrOperator
        nonReentrant
    {
        address pool = _recordPool(marketId);
        if (pool == address(0)) revert InvalidMarket();
        _checkPoolAssetWiring(marketId, pool);
        if (newQuantityRemaining == 0 || newQuantityRemaining > maxOrderQuantity) revert InvalidOrder();
        IBinaryPoolVillaAccount(pool).reduceOrder(orderId, newQuantityRemaining);
        emit OrderReduced(marketId, orderId, newQuantityRemaining);
    }

    function operatorMintSet(bytes32 marketId, uint256 amount) external onlyOperator nonReentrant {
        if (!autonomousTradingEnabled) revert AutonomousTradingDisabled();
        if (amount == 0 || amount > maxOrderCollateral) revert AmountZero();
        _consumeExposure(amount, true);
        (address pool, ) = _currentPoolAndUnit(marketId);
        _approveExact(pool, amount);
        IBinaryPoolVillaAccount(pool).mintSet(address(this), address(this), amount);
        _safeCall(collateralToken, abi.encodeWithSignature("approve(address,uint256)", pool, 0));
        emit CompleteSetMinted(marketId, amount);
    }

    function operatorBurnSet(bytes32 marketId, uint256 amount) external onlyOwnerOrOperator nonReentrant {
        if (amount == 0 || amount > maxOrderQuantity) revert AmountZero();
        address pool = _recordPool(marketId);
        if (pool == address(0)) revert InvalidMarket();
        _checkPoolAssetWiring(marketId, pool);
        _setOutcomeOperator(pool, true);
        IBinaryPoolVillaAccount(pool).burnSet(amount);
        emit CompleteSetBurned(marketId, amount);
    }

    function operatorRedeem(bytes32 marketId, uint8 outcomeIdx, uint256 amount) external onlyOwnerOrOperator nonReentrant {
        if (outcomeIdx > 1 || amount == 0) revert InvalidOutcome();
        address pool = _recordPool(marketId);
        if (pool == address(0)) revert InvalidMarket();
        _checkPoolAssetWiring(marketId, pool);
        _setOutcomeOperator(binaryModule, true);
        IBinaryModuleVillaAccount(binaryModule).redeem(0, bytes32(0), marketId, outcomeIdx, amount);
        emit Redeemed(marketId, outcomeIdx, amount);
    }

    /// @notice Claims this account's fixed DreamDEX pool-vault credit into the account.
    ///         It can never pay the operator because the pool sees this account as caller.
    function operatorClaimVault(bytes32 marketId, uint256 amount) external onlyOwnerOrOperator nonReentrant {
        if (amount == 0) revert AmountZero();
        address pool = _recordPool(marketId);
        if (pool == address(0)) revert InvalidMarket();
        _checkPoolAssetWiring(marketId, pool);
        IBinaryPoolVillaAccount(pool).withdraw(collateralToken, amount);
        emit VaultClaimed(marketId, amount);
    }

    /// @notice Owner-only vault recovery, still routed into the account first.
    function ownerClaimVault(bytes32 marketId, uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert AmountZero();
        address pool = _recordPool(marketId);
        if (pool == address(0)) revert InvalidMarket();
        _checkPoolAssetWiring(marketId, pool);
        IBinaryPoolVillaAccount(pool).withdraw(collateralToken, amount);
        emit VaultClaimed(marketId, amount);
    }

    /// @notice Owner-only recovery of tokens that are not VILLA protocol assets.
    function recoverUnsupportedToken(address token, uint256 amount) external onlyOwner nonReentrant {
        if (token == address(0) || token == collateralToken || token == outcomeToken || amount == 0) {
            revert UnsupportedToken();
        }
        _safeCall(token, abi.encodeWithSignature("transfer(address,uint256)", owner, amount));
    }

    function _prepareMarket(bytes32 marketId) internal {
        if (marketId == bytes32(0)) revert InvalidMarket();
        address pool = _recordPool(marketId);
        if (pool == address(0)) revert InvalidMarket();
        _checkPoolAssetWiring(marketId, pool);
        IBinaryPoolVillaAccount.BinaryPoolParams memory params = IBinaryPoolVillaAccount(pool).getBinaryPoolParams();
        if (params.finalized || params.oneCollateral == 0) revert MarketNotCurrent();
        _setOutcomeOperator(pool, true);
        _setOutcomeOperator(binaryModule, true);
        preparedMarkets[marketId] = true;
        emit MarketPrepared(marketId, pool);
    }

    function _recordPool(bytes32 marketId) internal view returns (address pool) {
        IBinaryModuleVillaAccount.MarketRecord memory record = IBinaryModuleVillaAccount(binaryModule).markets(marketId);
        pool = record.pool;
        if (pool == address(0) || record.collateral != collateralToken) revert InvalidMarket();
    }

    function _currentPool(bytes32 marketId) internal returns (address pool) {
        (pool, ) = _currentPoolAndUnit(marketId);
    }

    function _currentPoolAndUnit(bytes32 marketId) internal returns (address pool, uint256 oneCollateral) {
        if (!preparedMarkets[marketId]) {
            if (msg.sender == owner || (msg.sender == operator && autonomousTradingEnabled)) {
                _prepareMarket(marketId);
            } else {
                revert MarketNotPrepared();
            }
        }
        pool = _recordPool(marketId);
        _checkPoolAssetWiring(marketId, pool);
        IBinaryPoolVillaAccount.BinaryPoolParams memory params = IBinaryPoolVillaAccount(pool).getBinaryPoolParams();
        oneCollateral = params.oneCollateral;
        if (
            params.finalized ||
            oneCollateral == 0
        ) revert MarketNotCurrent();
    }

    function _checkPoolAssetWiring(bytes32 marketId, address pool) internal view {
        IBinaryModuleVillaAccount.MarketRecord memory record = IBinaryModuleVillaAccount(binaryModule).markets(marketId);
        IBinaryPoolVillaAccount.BinaryPoolParams memory params = IBinaryPoolVillaAccount(pool).getBinaryPoolParams();
        if (
            record.outcomeSlotCount != 2 ||
            record.market == address(0) ||
            record.yesId == 0 ||
            record.noId == 0 ||
            record.yesId == record.noId ||
            params.collateralToken != collateralToken ||
            params.outcomeToken != outcomeToken ||
            params.settlement != binarySettlement ||
            params.market == address(0) ||
            params.market != record.market ||
            params.yesId != record.yesId ||
            params.noId != record.noId
        ) {
            revert InvalidMarket();
        }
    }

    function _setOutcomeOperator(address spender, bool approved) internal {
        (bool ok, bytes memory result) = outcomeToken.call(
            abi.encodeWithSignature("setOperator(address,bool)", spender, approved)
        );
        if (!ok || (result.length != 0 && !abi.decode(result, (bool)))) revert TokenCallFailed();
    }

    function _approveExact(address pool, uint256 amount) internal {
        uint256 current = IERC20VillaAccount(collateralToken).allowance(address(this), pool);
        if (current != 0) _safeCall(collateralToken, abi.encodeWithSignature("approve(address,uint256)", pool, 0));
        _safeCall(collateralToken, abi.encodeWithSignature("approve(address,uint256)", pool, amount));
    }

    function _consumeExposure(uint256 amount, bool isMint) internal {
        if (amount == 0) return;
        if (amount > maxAggregateExposure || aggregateExposure > maxAggregateExposure - amount) {
            revert ExposureLimitExceeded();
        }
        if (isMint && (amount > maxMintExposure || mintExposure > maxMintExposure - amount)) {
            revert MintLimitExceeded();
        }
        aggregateExposure += amount;
        if (isMint) mintExposure += amount;
    }

    function _safeCall(address target, bytes memory data) internal {
        (bool ok, bytes memory result) = target.call(data);
        if (!ok) {
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
        if (result.length != 0 && !abi.decode(result, (bool))) revert TokenCallFailed();
    }

    function _ceilDiv(uint256 numerator, uint256 denominator) internal pure returns (uint256) {
        return (numerator + denominator - 1) / denominator;
    }
}

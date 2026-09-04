// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title VILLA per-user Event Contract account V2
/// @notice A deliberately narrow account boundary for one LP wallet and one
///         VILLA automation operator with bounded autonomous market operation.
///         It is not a generic smart wallet.

interface IERC20VillaAccount {
    function allowance(address owner, address spender) external view returns (uint256);
    function balanceOf(address owner) external view returns (uint256);
}

interface IERC6909VillaAccount {
    function balanceOf(address owner, uint256 id) external view returns (uint256);
    function setOperator(address spender, bool approved) external returns (bool);
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

    /// @dev Exact IOrderBook read tuple used by DreamDEX. `getOrder` only
    /// returns active orders; filled/cancelled/reduced-old ids revert.
    struct Order {
        uint128 orderId;
        bool isBid;
        address owner;
        uint64 userData;
        uint256 price;
        uint256 fullQuantity;
        uint256 quantityRemaining;
        uint64 expireTimestampNs;
    }

    function getBinaryPoolParams() external view returns (BinaryPoolParams memory);
    function getOwnOpenOrders() external view returns (uint128[] memory);
    function getOrder(uint128 orderId) external view returns (Order memory);
    function booksEmpty() external view returns (bool);

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
    error ExposureStateUnavailable();
    error MarketNotTracked();
    error MarketExposureOutstanding();
    error TrackedMarketLimitExceeded();
    error OrderUserDataInvalid();
    error PoolRecycleNotProven();

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

    /// @dev Exposure is recomputed from bounded, authoritative pool and token
    /// reads. It is deliberately not a lifetime counter: real release events
    /// release capacity without trusting an optimistic decrement.
    uint256 public constant MAX_TRACKED_MARKETS = 64;
    uint256 public constant MAX_OPEN_ORDERS_PER_POOL = 128;
    uint64 private constant ORDER_USER_DATA_MAGIC = 0xA000000000000000;
    uint64 private constant ORDER_USER_DATA_MAGIC_MASK = 0xF000000000000000;
    uint64 private constant ORDER_USER_DATA_PAYLOAD_MASK = 0x03FFFFFFFFFFFFFF;

    struct MarketBinding {
        address pool;
        address market;
        uint256 yesId;
        uint256 noId;
        uint256 oneCollateral;
        uint64 marketNonce;
        bool poolRecycled;
    }

    mapping(bytes32 marketId => bool prepared) public preparedMarkets;
    mapping(bytes32 marketId => bool trackedMarkets) public trackedMarkets;
    mapping(bytes32 marketId => MarketBinding binding) public marketBindings;
    mapping(bytes32 marketId => uint256 indexPlusOne) private _trackedMarketIndex;
    bytes32[] private _trackedMarketIds;
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

    /// @notice Owner-set upper bounds for current operator exposure. Lowering a
    ///         bound below live exposure is allowed and acts as an emergency
    ///         halt for risk-increasing calls until cleanup releases capacity.
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
        if (approved) {
            _prepareMarket(marketId);
        } else {
            // Do not delete the binding: live inventory/order state must remain
            // visible to the risk walk until an explicit zero-exposure release.
            preparedMarkets[marketId] = false;
        }
        emit MarketApprovalUpdated(marketId, approved);
    }

    /// @notice Current aggregate exposure across all tracked markets. This is
    /// an authoritative read, not a cumulative volume counter.
    function currentOperatorExposure() public view returns (uint256 total) {
        for (uint256 i = 0; i < _trackedMarketIds.length; i++) {
            total += _marketExposure(_trackedMarketIds[i], marketBindings[_trackedMarketIds[i]]).aggregateExposure;
        }
    }

    /// @notice Current inventory plus live sell escrow, used for the mint cap.
    function currentMintExposure() public view returns (uint256 total) {
        for (uint256 i = 0; i < _trackedMarketIds.length; i++) {
            total += _marketExposure(_trackedMarketIds[i], marketBindings[_trackedMarketIds[i]]).mintExposure;
        }
    }

    /// @dev Compatibility names retained for the dashboard/account reader. Both
    /// now report current authoritative state rather than lifetime volume.
    function aggregateExposure() external view returns (uint256) {
        return currentOperatorExposure();
    }

    function mintExposure() external view returns (uint256) {
        return currentMintExposure();
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
        preparedMarkets[marketId] = false;
        if (trackedMarkets[marketId]) {
            MarketBinding memory binding = marketBindings[marketId];
            _checkSettlementBinding(marketId, binding);
            IBinaryPoolVillaAccount.BinaryPoolParams memory params = IBinaryPoolVillaAccount(pool).getBinaryPoolParams();
            // A recycled pool approval is account-wide for its successor. Do
            // not revoke it while another market is using the same pool.
            if (params.market == binding.market && params.marketNonce == binding.marketNonce) {
                _setOutcomeOperator(pool, false);
                _safeCall(collateralToken, abi.encodeWithSignature("approve(address,uint256)", pool, 0));
            }
        } else {
            _checkPoolAssetWiring(marketId, pool);
            _setOutcomeOperator(pool, false);
            _safeCall(collateralToken, abi.encodeWithSignature("approve(address,uint256)", pool, 0));
        }
        // The module/settlement grants are global to this account. Keep them
        // while any tracked market can still require redemption or settlement.
        if (_trackedMarketIds.length == 0) {
            _setOutcomeOperator(binaryModule, false);
            _setOutcomeOperator(binarySettlement, false);
        }
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
        if (
            kind > 3 ||
            price == 0 ||
            price >= oneCollateral ||
            quantity == 0 ||
            quantity > maxOrderQuantity ||
            userData > ORDER_USER_DATA_PAYLOAD_MASK
        ) {
            revert InvalidOrder();
        }
        if (orderType > 3) revert InvalidOrder();
        uint64 encodedUserData = _encodeOrderUserData(kind, userData);

        uint256 collateralRequired;
        if (kind == 0) {
            collateralRequired = _ceilDiv(quantity * price, oneCollateral);
        } else if (kind == 2) {
            collateralRequired = _ceilDiv(quantity * (oneCollateral - price), oneCollateral);
        }
        if (collateralRequired > maxOrderCollateral) revert OrderLimitExceeded();
        _enforceProjectedOrderExposure(marketId, kind, quantity, collateralRequired);
        if (collateralRequired != 0) _approveExact(pool, collateralRequired);

        (success, orderId) = _placeBinaryOrder(
            pool,
            kind,
            price,
            quantity,
            expireTimestampNs,
            orderType,
            encodedUserData
        );
        if (collateralRequired != 0) _safeCall(collateralToken, abi.encodeWithSignature("approve(address,uint256)", pool, 0));
        emit OrderPlaced(marketId, orderId, kind, price, quantity);
    }

    function operatorCancelOrder(bytes32 marketId, uint128 orderId) external onlyOwnerOrOperator nonReentrant {
        address pool = _requireCurrentMarket(marketId);
        IBinaryPoolVillaAccount(pool).cancelOrder(orderId);
        emit OrderCancelled(marketId, orderId);
    }

    function operatorReduceOrder(bytes32 marketId, uint128 orderId, uint256 newQuantityRemaining)
        external
        onlyOwnerOrOperator
        nonReentrant
    {
        address pool = _requireCurrentMarket(marketId);
        if (newQuantityRemaining == 0 || newQuantityRemaining > maxOrderQuantity) revert InvalidOrder();
        IBinaryPoolVillaAccount(pool).reduceOrder(orderId, newQuantityRemaining);
        emit OrderReduced(marketId, orderId, newQuantityRemaining);
    }

    function operatorMintSet(bytes32 marketId, uint256 amount) external onlyOperator nonReentrant {
        if (!autonomousTradingEnabled) revert AutonomousTradingDisabled();
        if (amount == 0 || amount > maxOrderCollateral) revert AmountZero();
        (address pool, ) = _currentPoolAndUnit(marketId);
        _enforceMintExposure(amount);
        _approveExact(pool, amount);
        IBinaryPoolVillaAccount(pool).mintSet(address(this), address(this), amount);
        _safeCall(collateralToken, abi.encodeWithSignature("approve(address,uint256)", pool, 0));
        emit CompleteSetMinted(marketId, amount);
    }

    function operatorBurnSet(bytes32 marketId, uint256 amount) external onlyOwnerOrOperator nonReentrant {
        if (amount == 0 || amount > maxOrderQuantity) revert AmountZero();
        address pool = _requireCurrentMarket(marketId);
        _setOutcomeOperator(pool, true);
        IBinaryPoolVillaAccount(pool).burnSet(amount);
        emit CompleteSetBurned(marketId, amount);
    }

    function operatorRedeem(bytes32 marketId, uint8 outcomeIdx, uint256 amount) external onlyOwnerOrOperator nonReentrant {
        if (outcomeIdx > 1 || amount == 0) revert InvalidOutcome();
        _requireSettlementMarket(marketId);
        _setOutcomeOperator(binaryModule, true);
        IBinaryModuleVillaAccount(binaryModule).redeem(0, bytes32(0), marketId, outcomeIdx, amount);
        emit Redeemed(marketId, outcomeIdx, amount);
    }

    /// @notice Claims this account's fixed DreamDEX pool-vault credit into the account.
    ///         It can never pay the operator because the pool sees this account as caller.
    function operatorClaimVault(bytes32 marketId, uint256 amount) external onlyOwnerOrOperator nonReentrant {
        if (amount == 0) revert AmountZero();
        address pool = _requireSettlementMarket(marketId);
        IBinaryPoolVillaAccount(pool).withdraw(collateralToken, amount);
        emit VaultClaimed(marketId, amount);
    }

    /// @notice Owner-only vault recovery, still routed into the account first.
    function ownerClaimVault(bytes32 marketId, uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert AmountZero();
        address pool = _requireSettlementMarket(marketId);
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
        _checkPoolAssetWiring(marketId, pool);
        IBinaryPoolVillaAccount.BinaryPoolParams memory params = IBinaryPoolVillaAccount(pool).getBinaryPoolParams();
        if (params.finalized || params.oneCollateral == 0) revert MarketNotCurrent();

        _markPoolRecycled(pool, params.market, params.marketNonce);
        if (!trackedMarkets[marketId]) {
            if (_trackedMarketIds.length >= MAX_TRACKED_MARKETS) revert TrackedMarketLimitExceeded();
            trackedMarkets[marketId] = true;
            _trackedMarketIds.push(marketId);
            _trackedMarketIndex[marketId] = _trackedMarketIds.length;
        } else {
            MarketBinding memory existing = marketBindings[marketId];
            if (
                existing.pool != pool ||
                existing.market != params.market ||
                existing.marketNonce != params.marketNonce ||
                existing.yesId != params.yesId ||
                existing.noId != params.noId
            ) revert InvalidMarket();
        }
        marketBindings[marketId] = MarketBinding(
            pool,
            params.market,
            params.yesId,
            params.noId,
            params.oneCollateral,
            params.marketNonce,
            false
        );
        _setOutcomeOperator(pool, true);
        _setOutcomeOperator(binaryModule, true);
        preparedMarkets[marketId] = true;
        emit MarketPrepared(marketId, pool);
    }

    /// @notice Remove a tracked market only after its authoritative live
    /// exposure is zero. This bounds the read walk across autonomous rollover.
    /// It is cleanup-only: it cannot place, mint, or expand permissions.
    function releaseMarket(bytes32 marketId) external onlyOwnerOrOperator nonReentrant {
        if (!trackedMarkets[marketId]) revert MarketNotTracked();
        MarketBinding memory binding = marketBindings[marketId];
        MarketExposure memory exposure = _marketExposure(marketId, binding);
        if (exposure.aggregateExposure != 0 || exposure.mintExposure != 0) revert MarketExposureOutstanding();

        IBinaryPoolVillaAccount.BinaryPoolParams memory params = IBinaryPoolVillaAccount(binding.pool).getBinaryPoolParams();
        if (params.market == binding.market && params.marketNonce == binding.marketNonce) {
            if (!IBinaryPoolVillaAccount(binding.pool).booksEmpty()) revert MarketExposureOutstanding();
        } else if (!binding.poolRecycled && !_recycleProven(params, binding)) {
            revert ExposureStateUnavailable();
        }

        uint256 index = _trackedMarketIndex[marketId] - 1;
        uint256 last = _trackedMarketIds.length - 1;
        if (index != last) {
            bytes32 moved = _trackedMarketIds[last];
            _trackedMarketIds[index] = moved;
            _trackedMarketIndex[moved] = index + 1;
        }
        _trackedMarketIds.pop();
        delete _trackedMarketIndex[marketId];
        delete trackedMarkets[marketId];
        delete preparedMarkets[marketId];
        delete marketBindings[marketId];
        emit MarketApprovalUpdated(marketId, false);
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
        if (!trackedMarkets[marketId]) revert MarketNotTracked();
        _checkPoolAssetWiring(marketId, pool);
        MarketBinding memory binding = marketBindings[marketId];
        IBinaryPoolVillaAccount.BinaryPoolParams memory params = IBinaryPoolVillaAccount(pool).getBinaryPoolParams();
        oneCollateral = params.oneCollateral;
        if (
            params.finalized ||
            oneCollateral == 0 ||
            binding.pool != pool ||
            binding.market != params.market ||
            binding.marketNonce != params.marketNonce ||
            binding.yesId != params.yesId ||
            binding.noId != params.noId ||
            binding.poolRecycled
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

    function _checkSettlementBinding(bytes32 marketId, MarketBinding memory binding) internal view {
        IBinaryModuleVillaAccount.MarketRecord memory record = IBinaryModuleVillaAccount(binaryModule).markets(marketId);
        if (
            binding.pool == address(0) ||
            binding.market == address(0) ||
            binding.yesId == 0 ||
            binding.noId == 0 ||
            binding.yesId == binding.noId ||
            binding.oneCollateral == 0 ||
            record.outcomeSlotCount != 2 ||
            record.collateral != collateralToken ||
            record.market != binding.market ||
            record.pool != binding.pool ||
            record.yesId != binding.yesId ||
            record.noId != binding.noId
        ) revert InvalidMarket();
    }

    function _requireSettlementMarket(bytes32 marketId) internal view returns (address pool) {
        if (!trackedMarkets[marketId]) revert MarketNotTracked();
        MarketBinding memory binding = marketBindings[marketId];
        _checkSettlementBinding(marketId, binding);
        return binding.pool;
    }

    function _requireCurrentMarket(bytes32 marketId) internal returns (address pool) {
        (pool, ) = _currentPoolAndUnit(marketId);
    }

    function _markPoolRecycled(address pool, address successorMarket, uint64 successorNonce) internal {
        for (uint256 i = 0; i < _trackedMarketIds.length; i++) {
            MarketBinding storage binding = marketBindings[_trackedMarketIds[i]];
            if (
                binding.pool != pool ||
                binding.market == successorMarket ||
                binding.poolRecycled
            ) continue;
            // The protocol's recycle is one-way and nonce-delimited. The live
            // book must be empty before VILLA accepts the successor binding;
            // otherwise the old market would become unaccounted risk.
            if (successorNonce <= binding.marketNonce || !IBinaryPoolVillaAccount(pool).booksEmpty()) {
                revert PoolRecycleNotProven();
            }
            binding.poolRecycled = true;
        }
    }

    struct MarketExposure {
        uint256 aggregateExposure;
        uint256 mintExposure;
        uint256 orderExposure;
        uint256 yesInventory;
        uint256 noInventory;
    }

    function _marketExposure(bytes32 marketId, MarketBinding memory binding)
        internal
        view
        returns (MarketExposure memory exposure)
    {
        if (!trackedMarkets[marketId] || binding.pool == address(0)) revert ExposureStateUnavailable();
        IBinaryPoolVillaAccount.BinaryPoolParams memory params = IBinaryPoolVillaAccount(binding.pool).getBinaryPoolParams();
        if (
            params.collateralToken != collateralToken ||
            params.outcomeToken != outcomeToken ||
            params.settlement != binarySettlement ||
            params.oneCollateral == 0
        ) revert ExposureStateUnavailable();

        bool current =
            params.market == binding.market &&
            params.marketNonce == binding.marketNonce &&
            params.yesId == binding.yesId &&
            params.noId == binding.noId;
        if (!current && !binding.poolRecycled && !_recycleProven(params, binding)) revert ExposureStateUnavailable();
        if (current && binding.poolRecycled) revert ExposureStateUnavailable();

        exposure.yesInventory = IERC6909VillaAccount(outcomeToken).balanceOf(address(this), binding.yesId);
        exposure.noInventory = IERC6909VillaAccount(outcomeToken).balanceOf(address(this), binding.noId);
        uint256 inventory = _max(exposure.yesInventory, exposure.noInventory);
        exposure.aggregateExposure = inventory;
        exposure.mintExposure = inventory;

        // Once the pool has moved to a successor, its active order book is for
        // that successor. The old binding retains inventory accounting but does
        // not inspect another market's order ids.
        if (!current) return exposure;

        uint128[] memory orderIds = IBinaryPoolVillaAccount(binding.pool).getOwnOpenOrders();
        if (orderIds.length > MAX_OPEN_ORDERS_PER_POOL) revert ExposureStateUnavailable();
        for (uint256 i = 0; i < orderIds.length; i++) {
            IBinaryPoolVillaAccount.Order memory order = IBinaryPoolVillaAccount(binding.pool).getOrder(orderIds[i]);
            if (order.owner != address(this) || order.quantityRemaining == 0) revert ExposureStateUnavailable();
            (uint8 kind, bool tagged) = _decodeOrderUserData(order.userData);
            uint256 orderExposure = order.quantityRemaining;
            bool sell = true;
            if (tagged) {
                sell = kind == 1 || kind == 3;
                if (!sell && order.price > 0 && order.price < params.oneCollateral) {
                    uint256 collateralRequired = kind == 0
                        ? _ceilDiv(order.quantityRemaining * order.price, params.oneCollateral)
                        : _ceilDiv(order.quantityRemaining * (params.oneCollateral - order.price), params.oneCollateral);
                    orderExposure = _max(collateralRequired, order.quantityRemaining);
                }
            }
            exposure.orderExposure += orderExposure;
            exposure.aggregateExposure += orderExposure;
            // An untagged order is treated as a possible sell and therefore
            // also consumes mint/inventory capacity. This is conservative and
            // avoids relying on the SDK's removed kindOf(userData) convention.
            if (sell) exposure.mintExposure += order.quantityRemaining;
        }
    }

    function _enforceProjectedOrderExposure(
        bytes32 marketId,
        uint8 kind,
        uint256 quantity,
        uint256 collateralRequired
    ) internal view {
        uint256 current = currentOperatorExposure();
        uint256 projected;
        if (kind == 0 || kind == 2) {
            // A buy may fill immediately. Quantity is the full binary payout
            // liability, while collateralRequired is the resting reservation.
            projected = current + _max(collateralRequired, quantity);
        } else {
            MarketBinding memory binding = marketBindings[marketId];
            MarketExposure memory market = _marketExposure(marketId, binding);
            uint256 afterInventory;
            if (kind == 1) {
                if (market.yesInventory < quantity) revert InvalidOrder();
                afterInventory = _max(market.yesInventory - quantity, market.noInventory);
            } else {
                if (market.noInventory < quantity) revert InvalidOrder();
                afterInventory = _max(market.yesInventory, market.noInventory - quantity);
            }
            projected = current - market.aggregateExposure + afterInventory + market.orderExposure + quantity;
        }
        if (projected > maxAggregateExposure) revert ExposureLimitExceeded();
    }

    function _enforceMintExposure(uint256 amount) internal view {
        uint256 currentAggregate = currentOperatorExposure();
        if (amount > maxAggregateExposure || currentAggregate > maxAggregateExposure - amount) {
            revert ExposureLimitExceeded();
        }
        uint256 currentMint = currentMintExposure();
        if (amount > maxMintExposure || currentMint > maxMintExposure - amount) {
            revert MintLimitExceeded();
        }
    }

    function _encodeOrderUserData(uint8 kind, uint64 payload) internal pure returns (uint64) {
        if (kind > 3 || payload > ORDER_USER_DATA_PAYLOAD_MASK) revert OrderUserDataInvalid();
        return ORDER_USER_DATA_MAGIC | (uint64(kind) << 58) | payload;
    }

    function _decodeOrderUserData(uint64 userData) internal pure returns (uint8 kind, bool tagged) {
        tagged = (userData & ORDER_USER_DATA_MAGIC_MASK) == ORDER_USER_DATA_MAGIC;
        if (tagged) kind = uint8((userData >> 58) & 3);
    }

    function _recycleProven(
        IBinaryPoolVillaAccount.BinaryPoolParams memory params,
        MarketBinding memory binding
    ) internal view returns (bool) {
        // DreamDEX increments marketNonce only for a successor binding, and the
        // protocol permits that transition only after the old book's release
        // gate has passed. A stale account must not call booksEmpty here: other
        // accounts may already have opened orders in the successor book.
        return
            params.market != binding.market &&
            params.marketNonce > binding.marketNonce;
    }

    function _placeBinaryOrder(
        address pool,
        uint8 kind,
        uint256 price,
        uint256 quantity,
        uint64 expireTimestampNs,
        uint8 orderType,
        uint64 userData
    ) internal returns (bool success, uint128 orderId) {
        return IBinaryPoolVillaAccount(pool).placeBinaryOrder(
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

    function _max(uint256 left, uint256 right) internal pure returns (uint256) {
        return left >= right ? left : right;
    }
}

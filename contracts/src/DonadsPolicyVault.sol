// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title DONADS Policy Vault
/// @notice Holds native MON and permits narrowly bounded delegated transfers.
/// @dev The owner remains in control and can revoke every session immediately.
contract DonadsPolicyVault {
    struct SessionPolicy {
        uint64 expiresAt;
        uint128 perTransactionLimitWei;
        uint128 dailyLimitWei;
        uint128 spentTodayWei;
        uint64 spendingDay;
        bool active;
    }

    address public immutable owner;
    bool public paused;
    bytes32 public shippingAddressHash;
    uint256 private entered;

    mapping(address sessionKey => SessionPolicy policy) public sessions;
    mapping(address recipient => bool allowed) public allowedRecipients;
    mapping(bytes32 actionHash => bool consumed) public consumedActions;
    mapping(bytes32 actionHash => uint64 validUntil) public authorizedActions;

    event Deposited(address indexed sender, uint256 amount);
    event SessionConfigured(address indexed sessionKey, uint64 expiresAt, uint128 perTransactionLimitWei, uint128 dailyLimitWei);
    event SessionRevoked(address indexed sessionKey);
    event RecipientPermissionSet(address indexed recipient, bool allowed);
    event ShippingAddressHashSet(bytes32 indexed shippingAddressHash);
    event PauseSet(bool paused);
    event NativeTransferExecuted(bytes32 indexed actionHash, address indexed sessionKey, address indexed recipient, uint256 amount);
    event NativeActionAuthorized(bytes32 indexed actionHash, address indexed sessionKey, bytes32 indexed missionId, uint64 validUntil);
    event OwnerWithdrawal(address indexed recipient, uint256 amount);

    error OnlyOwner();
    error VaultPaused();
    error ReentrantCall();
    error InvalidAddress();
    error InvalidPolicy();
    error SessionUnavailable();
    error RecipientNotAllowed();
    error PerTransactionLimitExceeded();
    error DailyLimitExceeded();
    error ActionAlreadyConsumed();
    error ActionNotAuthorized();
    error ActionAuthorizationExpired();
    error TransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    modifier nonReentrant() {
        if (entered != 0) revert ReentrantCall();
        entered = 1;
        _;
        entered = 0;
    }

    constructor() payable {
        owner = msg.sender;
        if (msg.value != 0) emit Deposited(msg.sender, msg.value);
    }

    receive() external payable {
        emit Deposited(msg.sender, msg.value);
    }

    function configureSession(
        address sessionKey,
        uint64 expiresAt,
        uint128 perTransactionLimitWei,
        uint128 dailyLimitWei
    ) external onlyOwner {
        if (sessionKey == address(0)) revert InvalidAddress();
        if (
            expiresAt <= block.timestamp || perTransactionLimitWei == 0
                || dailyLimitWei < perTransactionLimitWei
        ) revert InvalidPolicy();
        sessions[sessionKey] = SessionPolicy({
            expiresAt: expiresAt,
            perTransactionLimitWei: perTransactionLimitWei,
            dailyLimitWei: dailyLimitWei,
            spentTodayWei: 0,
            spendingDay: uint64(block.timestamp / 1 days),
            active: true
        });
        emit SessionConfigured(sessionKey, expiresAt, perTransactionLimitWei, dailyLimitWei);
    }

    function revokeSession(address sessionKey) external onlyOwner {
        sessions[sessionKey].active = false;
        emit SessionRevoked(sessionKey);
    }

    function setRecipientAllowed(address recipient, bool allowed) external onlyOwner {
        if (recipient == address(0)) revert InvalidAddress();
        allowedRecipients[recipient] = allowed;
        emit RecipientPermissionSet(recipient, allowed);
    }

    function setShippingAddressHash(bytes32 newHash) external onlyOwner {
        shippingAddressHash = newHash;
        emit ShippingAddressHashSet(newHash);
    }

    function setPaused(bool newPaused) external onlyOwner {
        paused = newPaused;
        emit PauseSet(newPaused);
    }

    /// @notice Authorizes one exact delegated native transfer.
    /// @dev The hash binds the action to this chain and vault so it cannot be
    /// replayed against another deployment. The owner may authorize off the
    /// critical execution path, while the session submits the exact action.
    function authorizeNativeAction(
        address sessionKey,
        address recipient,
        uint128 amountWei,
        bytes32 missionId,
        uint256 nonce,
        uint64 validUntil
    ) external onlyOwner returns (bytes32 actionHash) {
        if (sessionKey == address(0) || recipient == address(0)) revert InvalidAddress();
        if (amountWei == 0 || validUntil <= block.timestamp) revert InvalidPolicy();
        actionHash = nativeActionHash(sessionKey, recipient, amountWei, missionId, nonce, validUntil);
        if (consumedActions[actionHash]) revert ActionAlreadyConsumed();
        authorizedActions[actionHash] = validUntil;
        emit NativeActionAuthorized(actionHash, sessionKey, missionId, validUntil);
    }

    function nativeActionHash(
        address sessionKey,
        address recipient,
        uint128 amountWei,
        bytes32 missionId,
        uint256 nonce,
        uint64 validUntil
    ) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("DONADS_NATIVE_ACTION_V1"),
                block.chainid,
                address(this),
                sessionKey,
                recipient,
                amountWei,
                missionId,
                nonce,
                validUntil
            )
        );
    }

    function executeNative(
        address payable recipient,
        uint128 amountWei,
        bytes32 missionId,
        uint256 nonce,
        uint64 validUntil
    ) external nonReentrant {
        if (paused) revert VaultPaused();
        SessionPolicy storage policy = sessions[msg.sender];
        if (!policy.active || policy.expiresAt < block.timestamp) revert SessionUnavailable();
        if (!allowedRecipients[recipient]) revert RecipientNotAllowed();
        if (amountWei == 0 || amountWei > policy.perTransactionLimitWei) {
            revert PerTransactionLimitExceeded();
        }
        bytes32 actionHash = nativeActionHash(msg.sender, recipient, amountWei, missionId, nonce, validUntil);
        if (consumedActions[actionHash]) revert ActionAlreadyConsumed();
        uint64 authorizedUntil = authorizedActions[actionHash];
        if (authorizedUntil == 0 || authorizedUntil != validUntil) revert ActionNotAuthorized();
        if (validUntil < block.timestamp) revert ActionAuthorizationExpired();

        uint64 today = uint64(block.timestamp / 1 days);
        if (policy.spendingDay != today) {
            policy.spendingDay = today;
            policy.spentTodayWei = 0;
        }
        uint128 nextSpent = policy.spentTodayWei + amountWei;
        if (nextSpent > policy.dailyLimitWei) revert DailyLimitExceeded();

        policy.spentTodayWei = nextSpent;
        consumedActions[actionHash] = true;
        delete authorizedActions[actionHash];
        (bool sent,) = recipient.call{ value: amountWei }("");
        if (!sent) revert TransferFailed();
        emit NativeTransferExecuted(actionHash, msg.sender, recipient, amountWei);
    }

    function ownerWithdraw(address payable recipient, uint256 amountWei)
        external
        onlyOwner
        nonReentrant
    {
        if (recipient == address(0)) revert InvalidAddress();
        (bool sent,) = recipient.call{ value: amountWei }("");
        if (!sent) revert TransferFailed();
        emit OwnerWithdrawal(recipient, amountWei);
    }
}

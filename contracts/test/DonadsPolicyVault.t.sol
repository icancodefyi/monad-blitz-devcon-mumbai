// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { DonadsPolicyVault } from "../src/DonadsPolicyVault.sol";

contract NativeReceiver {
    receive() external payable { }
}

contract SessionActor {
    function execute(
        DonadsPolicyVault vault,
        address payable recipient,
        uint128 amountWei,
        bytes32 missionId,
        uint256 nonce,
        uint64 validUntil
    ) external {
        vault.executeNative(recipient, amountWei, missionId, nonce, validUntil);
    }

    function pause(DonadsPolicyVault vault) external {
        vault.setPaused(true);
    }
}

contract DonadsPolicyVaultTest {
    DonadsPolicyVault private vault;
    NativeReceiver private receiver;
    SessionActor private session;

    receive() external payable { }

    function setUp() public {
        vault = new DonadsPolicyVault();
        receiver = new NativeReceiver();
        session = new SessionActor();
        vault.configureSession(address(session), uint64(block.timestamp + 1 days), 2 ether, 3 ether);
        vault.setRecipientAllowed(address(receiver), true);
    }

    function authorize(uint128 amountWei, bytes32 missionId, uint256 nonce) private returns (uint64 validUntil) {
        validUntil = uint64(block.timestamp + 1 hours);
        vault.authorizeNativeAction(address(session), address(receiver), amountWei, missionId, nonce, validUntil);
    }

    function testOwnerAndSessionPolicy() public view {
        require(vault.owner() == address(this), "owner mismatch");
        (
            uint64 expiresAt,
            uint128 perTx,
            uint128 daily,
            uint128 spentToday,
            uint64 spendingDay,
            bool active
        ) = vault.sessions(address(session));
        require(expiresAt > block.timestamp, "expiry mismatch");
        require(perTx == 2 ether && daily == 3 ether && active, "policy mismatch");
        require(spentToday == 0 && spendingDay == block.timestamp / 1 days, "spending mismatch");
    }

    function testRejectsUnapprovedRecipient() public {
        bytes32 missionId = keccak256("blocked");
        uint64 validUntil = uint64(block.timestamp + 1 hours);
        vault.authorizeNativeAction(address(session), address(0xBEEF), 1, missionId, 1, validUntil);
        (bool success,) = address(session).call(
            abi.encodeCall(
                session.execute,
                (vault, payable(address(0xBEEF)), 1, missionId, 1, validUntil)
            )
        );
        require(!success, "unapproved recipient accepted");
    }

    function testExecutesBoundedTransferAndAccountsForSpend() public {
        payable(address(vault)).transfer(2 ether);
        uint256 balanceBefore = address(receiver).balance;
        bytes32 missionId = keccak256("bounded");
        uint64 validUntil = authorize(2 ether, missionId, 1);
        session.execute(vault, payable(address(receiver)), 2 ether, missionId, 1, validUntil);

        (,,, uint128 spentToday,,) = vault.sessions(address(session));
        require(spentToday == 2 ether, "spend not accounted");
        require(address(receiver).balance == balanceBefore + 2 ether, "recipient not paid");
    }

    function testRejectsReplay() public {
        payable(address(vault)).transfer(2);
        bytes32 missionId = keccak256("one-action");
        uint64 validUntil = authorize(1, missionId, 1);
        session.execute(vault, payable(address(receiver)), 1, missionId, 1, validUntil);
        (bool success,) = address(session).call(
            abi.encodeCall(session.execute, (vault, payable(address(receiver)), 1, missionId, 1, validUntil))
        );
        require(!success, "replayed action accepted");
    }

    function testEnforcesPerTransactionAndDailyLimits() public {
        payable(address(vault)).transfer(4 ether);
        bytes32 overMission = keccak256("over-per-tx");
        uint64 overExpiry = authorize(uint128(2 ether + 1), overMission, 1);
        (bool overPerTransaction,) = address(session).call(
            abi.encodeCall(
                session.execute,
                (vault, payable(address(receiver)), uint128(2 ether + 1), overMission, 1, overExpiry)
            )
        );
        require(!overPerTransaction, "per-transaction limit bypassed");

        bytes32 firstMission = keccak256("daily-first");
        uint64 firstExpiry = authorize(2 ether, firstMission, 2);
        session.execute(vault, payable(address(receiver)), 2 ether, firstMission, 2, firstExpiry);
        bytes32 secondMission = keccak256("daily-second");
        uint64 secondExpiry = authorize(2 ether, secondMission, 3);
        (bool overDaily,) = address(session).call(
            abi.encodeCall(
                session.execute,
                (vault, payable(address(receiver)), 2 ether, secondMission, 3, secondExpiry)
            )
        );
        require(!overDaily, "daily limit bypassed");
    }

    function testRevocationBlocksSession() public {
        vault.revokeSession(address(session));
        bytes32 missionId = keccak256("revoked");
        uint64 validUntil = authorize(1, missionId, 1);
        (bool success,) = address(session).call(
            abi.encodeCall(
                session.execute,
                (vault, payable(address(receiver)), 1, missionId, 1, validUntil)
            )
        );
        require(!success, "revoked session executed");
    }

    function testKillSwitchBlocksExecution() public {
        vault.setPaused(true);
        bytes32 missionId = keccak256("paused");
        uint64 validUntil = authorize(1, missionId, 1);
        (bool success,) = address(session).call(
            abi.encodeCall(
                session.execute,
                (vault, payable(address(receiver)), 1, missionId, 1, validUntil)
            )
        );
        require(!success, "paused vault executed");
    }

    function testRejectsNonOwnerAdministration() public {
        (bool success,) = address(session).call(abi.encodeCall(session.pause, (vault)));
        require(!success, "non-owner paused vault");
    }

    function testRejectsInventedActionHash() public {
        payable(address(vault)).transfer(1);
        (bool success,) = address(session).call(
            abi.encodeCall(
                session.execute,
                (vault, payable(address(receiver)), 1, keccak256("invented"), 99, uint64(block.timestamp + 1 hours))
            )
        );
        require(!success, "session invented an unauthorized action");
    }

    function testFuzzBoundedTransferPreservesAccounting(uint128 seedAmount, uint256 nonce, bytes32 missionId) public {
        uint128 amount = uint128(uint256(seedAmount) % 2 ether) + 1;
        payable(address(vault)).transfer(amount);
        uint256 receiverBefore = address(receiver).balance;
        uint64 validUntil = authorize(amount, missionId, nonce);
        session.execute(vault, payable(address(receiver)), amount, missionId, nonce, validUntil);
        (,,, uint128 spentToday,,) = vault.sessions(address(session));
        require(spentToday == amount, "fuzz spend accounting mismatch");
        require(address(receiver).balance == receiverBefore + amount, "fuzz recipient delta mismatch");
    }

    function testFuzzActionHashBindsNonce(uint128 seedAmount, uint256 nonce, bytes32 missionId) public view {
        uint128 amount = uint128(uint256(seedAmount) % 2 ether) + 1;
        uint64 validUntil = uint64(block.timestamp + 1 hours);
        bytes32 first = vault.nativeActionHash(address(session), address(receiver), amount, missionId, nonce, validUntil);
        bytes32 second = vault.nativeActionHash(address(session), address(receiver), amount, missionId, nonce ^ 1, validUntil);
        require(first != second, "nonce is not bound to action hash");
    }
}

contract DonadsPolicyVaultInvariantTest {
    DonadsPolicyVault private vault;
    SessionActor private session;
    NativeReceiver private receiver;

    function setUp() public {
        vault = new DonadsPolicyVault();
        session = new SessionActor();
        receiver = new NativeReceiver();
        vault.configureSession(address(session), uint64(block.timestamp + 30 days), 2 ether, 5 ether);
        vault.setRecipientAllowed(address(receiver), true);
    }

    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(vault);
    }

    function invariantOwnerNeverChanges() public view {
        require(vault.owner() == address(this), "vault owner changed");
    }

    function invariantSessionSpendNeverExceedsDailyLimit() public view {
        (,, uint128 dailyLimit, uint128 spentToday,,) = vault.sessions(address(session));
        require(spentToday <= dailyLimit, "session exceeded daily limit");
    }

    function invariantConfiguredDailyLimitCoversPerTransactionLimit() public view {
        (, uint128 perTransaction, uint128 dailyLimit,,,) = vault.sessions(address(session));
        require(dailyLimit >= perTransaction, "invalid configured limits");
    }
}

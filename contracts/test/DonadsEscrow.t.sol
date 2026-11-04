// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { DonadsEscrow } from "../src/DonadsEscrow.sol";

contract EscrowActor {
    receive() external payable { }
    function release(DonadsEscrow escrow) external { escrow.release(); }
    function refund(DonadsEscrow escrow) external { escrow.cooperativeRefund(); }
    function dispute(DonadsEscrow escrow, bytes32 evidence) external { escrow.raiseDispute(evidence); }
    function resolve(DonadsEscrow escrow, bool sellerWins, bytes32 resolution) external { escrow.resolve(sellerWins, resolution); }
}

contract DonadsEscrowTest {
    EscrowActor private buyer;
    EscrowActor private seller;
    EscrowActor private arbiter;

    receive() external payable { }

    function setUp() public {
        buyer = new EscrowActor();
        seller = new EscrowActor();
        arbiter = new EscrowActor();
    }

    function _escrow() private returns (DonadsEscrow) {
        return new DonadsEscrow{ value: 1 ether }(address(buyer), payable(address(seller)), address(arbiter), uint64(block.timestamp + 1 days), keccak256("milestone-v1"));
    }

    function testBuyerReleasesMilestone() public {
        DonadsEscrow escrow = _escrow();
        uint256 beforeBalance = address(seller).balance;
        buyer.release(escrow);
        require(uint256(escrow.state()) == 2, "not released");
        require(address(seller).balance == beforeBalance + 1 ether, "seller not paid");
    }

    function testSellerCanCooperativelyRefund() public {
        DonadsEscrow escrow = _escrow();
        uint256 beforeBalance = address(buyer).balance;
        seller.refund(escrow);
        require(uint256(escrow.state()) == 3, "not refunded");
        require(address(buyer).balance == beforeBalance + 1 ether, "buyer not refunded");
    }

    function testArbiterResolvesDisputeWithReceiptHash() public {
        DonadsEscrow escrow = _escrow();
        buyer.dispute(escrow, keccak256("delivery-evidence"));
        arbiter.resolve(escrow, true, keccak256("resolution"));
        require(uint256(escrow.state()) == 4, "not resolved");
        require(address(escrow).balance == 0, "funds remain locked");
    }

    function testUnauthorizedReleaseIsBlocked() public {
        DonadsEscrow escrow = _escrow();
        (bool success,) = address(seller).call(abi.encodeCall(seller.release, (escrow)));
        require(!success, "unauthorized release succeeded");
        require(uint256(escrow.state()) == 0, "state changed");
    }

    function testFuzzConstructorPreservesFundsAndTerms(uint96 seedAmount, bytes32 seedTerms) public {
        uint256 amount = uint256(seedAmount) % 10 ether + 1;
        bytes32 terms = seedTerms == bytes32(0) ? keccak256("non-zero-terms") : seedTerms;
        DonadsEscrow escrow = new DonadsEscrow{ value: amount }(address(buyer), payable(address(seller)), address(arbiter), uint64(block.timestamp + 1 days), terms);
        require(escrow.fundedAmount() == amount, "funded amount mismatch");
        require(address(escrow).balance == amount, "escrow balance mismatch");
        require(escrow.termsHash() == terms, "terms hash mismatch");
    }
}

contract DonadsEscrowInvariantTest {
    DonadsEscrow private escrow;
    EscrowActor private buyer;
    EscrowActor private seller;
    EscrowActor private arbiter;

    function setUp() public {
        buyer = new EscrowActor();
        seller = new EscrowActor();
        arbiter = new EscrowActor();
        escrow = new DonadsEscrow{ value: 1 ether }(address(buyer), payable(address(seller)), address(arbiter), uint64(block.timestamp + 30 days), keccak256("invariant-terms"));
    }

    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(escrow);
    }

    function invariantFundsMatchLifecycleState() public view {
        uint256 state = uint256(escrow.state());
        if (state <= 1) require(address(escrow).balance == escrow.fundedAmount(), "active escrow lost funds");
        else require(address(escrow).balance == 0, "terminal escrow retained funds");
    }

    function invariantPartiesAndTermsAreImmutable() public view {
        require(escrow.buyer() == address(buyer), "buyer changed");
        require(escrow.seller() == address(seller), "seller changed");
        require(escrow.arbiter() == address(arbiter), "arbiter changed");
        require(escrow.termsHash() == keccak256("invariant-terms"), "terms changed");
    }
}

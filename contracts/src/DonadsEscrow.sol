// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title DONADS P2P Escrow
/// @notice Holds native MON for one buyer/seller milestone with release, cooperative refund, timeout, and dispute resolution.
contract DonadsEscrow {
    enum State { Funded, Disputed, Released, Refunded, Resolved }

    address public immutable buyer;
    address payable public immutable seller;
    address public immutable arbiter;
    uint64 public immutable refundAfter;
    bytes32 public immutable termsHash;
    uint256 public immutable fundedAmount;
    State public state;
    uint256 private entered;

    event Funded(address indexed buyer, address indexed seller, uint256 amount, bytes32 indexed termsHash, uint64 refundAfter);
    event DisputeRaised(address indexed raisedBy, bytes32 indexed evidenceHash);
    event Released(address indexed approvedBy, address indexed seller, uint256 amount);
    event Refunded(address indexed approvedBy, address indexed buyer, uint256 amount, bool timeout);
    event Resolved(address indexed arbiter, address indexed recipient, uint256 amount, bytes32 resolutionHash);

    error Unauthorized();
    error InvalidEscrow();
    error InvalidState();
    error TimeoutNotReached();
    error TransferFailed();
    error ReentrantCall();

    modifier nonReentrant() {
        if (entered != 0) revert ReentrantCall();
        entered = 1;
        _;
        entered = 0;
    }

    constructor(address buyer_, address payable seller_, address arbiter_, uint64 refundAfter_, bytes32 termsHash_) payable {
        if (buyer_ == address(0) || seller_ == address(0) || arbiter_ == address(0) || buyer_ == seller_ || msg.value == 0 || refundAfter_ <= block.timestamp || termsHash_ == bytes32(0)) revert InvalidEscrow();
        buyer = buyer_;
        seller = seller_;
        arbiter = arbiter_;
        refundAfter = refundAfter_;
        termsHash = termsHash_;
        fundedAmount = msg.value;
        state = State.Funded;
        emit Funded(buyer_, seller_, msg.value, termsHash_, refundAfter_);
    }

    function release() external nonReentrant {
        if (msg.sender != buyer) revert Unauthorized();
        if (state != State.Funded) revert InvalidState();
        state = State.Released;
        _send(seller, fundedAmount);
        emit Released(msg.sender, seller, fundedAmount);
    }

    function cooperativeRefund() external nonReentrant {
        if (msg.sender != seller) revert Unauthorized();
        if (state != State.Funded) revert InvalidState();
        state = State.Refunded;
        _send(payable(buyer), fundedAmount);
        emit Refunded(msg.sender, buyer, fundedAmount, false);
    }

    function timeoutRefund() external nonReentrant {
        if (msg.sender != buyer) revert Unauthorized();
        if (state != State.Funded) revert InvalidState();
        if (block.timestamp < refundAfter) revert TimeoutNotReached();
        state = State.Refunded;
        _send(payable(buyer), fundedAmount);
        emit Refunded(msg.sender, buyer, fundedAmount, true);
    }

    function raiseDispute(bytes32 evidenceHash) external {
        if (msg.sender != buyer && msg.sender != seller) revert Unauthorized();
        if (state != State.Funded || evidenceHash == bytes32(0)) revert InvalidState();
        state = State.Disputed;
        emit DisputeRaised(msg.sender, evidenceHash);
    }

    function resolve(bool releaseToSeller, bytes32 resolutionHash) external nonReentrant {
        if (msg.sender != arbiter) revert Unauthorized();
        if (state != State.Disputed || resolutionHash == bytes32(0)) revert InvalidState();
        state = State.Resolved;
        address payable recipient = releaseToSeller ? seller : payable(buyer);
        _send(recipient, fundedAmount);
        emit Resolved(msg.sender, recipient, fundedAmount, resolutionHash);
    }

    function _send(address payable recipient, uint256 amount) private {
        (bool sent,) = recipient.call{ value: amount }("");
        if (!sent) revert TransferFailed();
    }
}

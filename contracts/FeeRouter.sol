// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @notice The venue's fee escrow. Creator fees are credited to a recipient
///         and sit there until the recipient takes them.
interface IFeeEscrow {
    function claim() external;
    function balanceOf(address account) external view returns (uint256);
}

/// @notice The venue's launch factory. Only the current fee recipient may
///         move the recipient, which is what makes `moveRecipient` privileged
///         rather than merely rude.
interface ILaunchFactory {
    function transferCreatorFeeRecipient(address token, address recipient) external;
}

/// @notice A chip: one clock edge per call, open to every address.
interface IChip {
    function step(uint256 inValue) external;
}

/// @title  FeeRouter
/// @notice Takes the creator fee, pays most of it to development, and spends
///         the rest making clock edges free to take.
/// @dev    Three things about the venue shaped every decision in here, and all
///         three were read off chain rather than assumed.
///
///         Fees are not pushed. They accrue in an escrow credited to the fee
///         recipient and are taken with `claim()`. A router that waited to be
///         paid would wait for ever, so `collect` is the reason this contract
///         exists and it is open to anyone: funding that depends on one person
///         remembering to press a button is funding with an owner.
///
///         The recipient may be a contract. That was the blocking question and
///         simulating the factory call against two different contracts settled
///         it; only the zero address is refused.
///
///         Only the current recipient may move the recipient. Once this
///         contract holds that position nobody else can take it back, so it
///         keeps `moveRecipient` for one address. That address can redirect
///         future fees and can do nothing else: it cannot reach the reserve,
///         the split, the chip or either public entry point. There is no
///         withdrawal function in this contract at all.
contract FeeRouter {
    /// @notice Where creator fees accrue until somebody claims them.
    IFeeEscrow public immutable ESCROW;

    /// @notice The launch factory, which owns the recipient record.
    ILaunchFactory public immutable FACTORY;

    /// @notice The token whose fee stream this contract receives.
    address public immutable TOKEN;

    /// @notice The chip whose edges the reserve pays for.
    /// @dev    Immutable, and there is no list. A router that reimbursed a call
    ///         to any address with a `step` function would be emptied by the
    ///         first contract somebody wrote to burn gas. At T-0 there is one
    ///         chip, so one address is the whole defence and it needs no owner
    ///         to maintain.
    IChip public immutable CHIP;

    /// @notice Where the development share is paid, on every collect.
    address public immutable DEV;

    /// @notice The development share, in basis points. The remainder is the
    ///         cycle reserve and stays in this contract.
    uint256 public immutable DEV_BPS;

    /// @notice The one address that may redirect future fees away from here.
    address public immutable STEWARD;

    /// @notice Ceiling on the gas price this contract will reimburse.
    /// @dev    Without it a caller sets an enormous gas price and the reserve
    ///         pays for it. Reimbursement is at the lower of this and the
    ///         transaction's own price, so an ordinary caller is unaffected.
    uint256 public immutable GAS_CAP;

    /// @notice Block number of the last reimbursed step.
    /// @dev    One reimbursement per block. The chip advances one edge per
    ///         block by design, so this forbids nothing anybody wanted to do
    ///         and removes the only way to drain the reserve quickly.
    uint256 public lastReimbursedBlock;

    /// @notice Total paid out to callers for taking edges.
    uint256 public totalReimbursed;

    /// @dev Gas spent outside the measured window: the call into this
    ///      contract, the accounting, and the transfer back. Approximate on
    ///      purpose and deliberately not generous, so reimbursement lands at
    ///      or a little under cost and never above it.
    uint256 private constant OVERHEAD = 48_000;

    /// @dev Transient reentrancy flag, cleared at the end of the transaction.
    bytes32 private constant LOCK = keccak256("stepper.router.lock");

    event Collected(address indexed caller, uint256 total, uint256 toDev, uint256 toReserve);
    event Stepped(address indexed caller, uint256 inValue, uint256 reimbursed);
    event RecipientMoved(address indexed to);

    error ZeroAddress();
    error BadSplit();
    error NotSteward();
    error NothingToCollect();
    error PayoutFailed();
    error Reentered();

    constructor(
        IFeeEscrow escrow,
        ILaunchFactory factory,
        address token,
        IChip chip,
        address dev,
        uint256 devBps,
        address steward,
        uint256 gasCap
    ) {
        if (address(escrow) == address(0) || address(factory) == address(0)) revert ZeroAddress();
        if (token == address(0) || address(chip) == address(0)) revert ZeroAddress();
        if (dev == address(0) || steward == address(0)) revert ZeroAddress();
        if (devBps > 10_000) revert BadSplit();
        if (gasCap == 0) revert BadSplit();

        ESCROW = escrow;
        FACTORY = factory;
        TOKEN = token;
        CHIP = chip;
        DEV = dev;
        DEV_BPS = devBps;
        STEWARD = steward;
        GAS_CAP = gasCap;
    }

    /// @notice Accepts the escrow's payout, and anything else anyone sends.
    /// @dev    Unattributed ETH becomes reserve. There is no way to take it
    ///         out again except by taking an edge, which is the point.
    receive() external payable {}

    /// @notice What is left after development has been paid: the cycle
    ///         reserve, in wei.
    function reserve() external view returns (uint256) {
        return address(this).balance;
    }

    /// @notice What the escrow is holding for this contract, unclaimed.
    function pending() external view returns (uint256) {
        return ESCROW.balanceOf(address(this));
    }

    /// @notice Claim the fees, pay development, keep the rest as reserve.
    /// @dev    Open to anyone. The split is computed from what actually
    ///         arrived rather than from what the escrow said was pending, so a
    ///         venue that pays partially cannot desynchronise the accounting.
    function collect() external {
        _enter();

        uint256 before = address(this).balance;
        ESCROW.claim();
        uint256 got = address(this).balance - before;
        if (got == 0) revert NothingToCollect();

        uint256 toDev = (got * DEV_BPS) / 10_000;
        if (toDev != 0) {
            (bool ok, ) = DEV.call{value: toDev}("");
            if (!ok) revert PayoutFailed();
        }

        emit Collected(msg.sender, got, toDev, got - toDev);
        _exit();
    }

    /// @notice Advance the chip one edge, and be paid back for the gas.
    /// @param  inValue the byte the chip reads on its input port this cycle.
    /// @dev    The chip is stepped whether or not the reserve can pay: the
    ///         clock is not conditional on this contract having money, it is
    ///         only cheaper when it does. Reimbursement is skipped, not
    ///         reverted, when the reserve is empty or the block has already
    ///         paid, so a caller who wants the edge anyway always gets it.
    function step(uint256 inValue) external {
        _enter();

        uint256 startGas = gasleft();
        CHIP.step(inValue);

        uint256 owed;
        if (lastReimbursedBlock != block.number) {
            uint256 price = tx.gasprice < GAS_CAP ? tx.gasprice : GAS_CAP;
            owed = (startGas - gasleft() + OVERHEAD) * price;

            uint256 balance = address(this).balance;
            if (owed > balance) owed = balance;

            if (owed != 0) {
                lastReimbursedBlock = block.number;
                totalReimbursed += owed;
                (bool ok, ) = msg.sender.call{value: owed}("");
                if (!ok) revert PayoutFailed();
            }
        }

        emit Stepped(msg.sender, inValue, owed);
        _exit();
    }

    /// @notice Redirect future fees away from this contract.
    /// @dev    The hatch, and the whole of it. It moves the stream and touches
    ///         nothing else: the reserve already here stays here and keeps
    ///         paying for edges until it is spent, whoever receives the fees
    ///         afterwards. This function is the only reason this contract has
    ///         a privileged address, and the documentation says so rather than
    ///         claiming an ownerlessness it does not have.
    function moveRecipient(address to) external {
        if (msg.sender != STEWARD) revert NotSteward();
        if (to == address(0)) revert ZeroAddress();
        FACTORY.transferCreatorFeeRecipient(TOKEN, to);
        emit RecipientMoved(to);
    }

    function _enter() private {
        bytes32 slot = LOCK;
        bool held;
        assembly ("memory-safe") {
            held := tload(slot)
            tstore(slot, 1)
        }
        if (held) revert Reentered();
    }

    function _exit() private {
        bytes32 slot = LOCK;
        assembly ("memory-safe") {
            tstore(slot, 0)
        }
    }
}

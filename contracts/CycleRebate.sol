// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @notice The chip, as far as this contract needs it.
interface IChip {
    function step(uint256 inValue) external;
    /// @dev There is no `cycle()` getter on a chip; the counter comes back
    ///      as the first field of the snapshot.
    function snapshot()
        external
        view
        returns (uint256 cycle, uint256 pc, uint256 outPort, bool carry, bool zero, bool halted);
}

/// @notice The reserve token.
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title  CycleRebate
/// @notice Buys one chip its next clock edge on your behalf, and pays you for
///         having asked.
///
/// @dev    A chip advances when somebody pays for the next edge, and nothing
///         about it earns: `step()` is not payable, the chip holds no balance,
///         and there is no withdrawal path in it. A processor with no
///         oscillator needs somebody to want the next edge enough to buy it.
///         This is a reserve that makes wanting it cheaper.
///
///         **What it pays for is work, never holding.** The only way to be
///         paid by this contract is to make the chip take a cycle. Holding the
///         token does nothing here and there is no function that would let it.
///         That distinction is the design and not a formality: a reserve that
///         pays for work is an incentive; a reserve that pays for holding is
///         something else with a different regulator.
///
///         **One chip, fixed at construction.** Not a registry, not a list,
///         not a set somebody can add to. An earlier draft paid for any chip a
///         factory had minted, which meant anybody could launch their own for
///         the price of a launch fee and drain the reserve into it. Naming one
///         address removes that attack rather than pricing around it.
///
///         **Everything else is immutable too.** The token, the chip and the
///         rate are set once. There is no owner, no pause, no setter and
///         nothing payable, so once a token is in here the only way out is
///         through `fuel()`, to somebody who advanced the chip. Nobody can
///         empty it, including whoever deploys it.
///
///         **Refilling is a transfer.** There is no deposit function because
///         none is needed: the reserve is this contract's balance. Anybody can
///         top it up by sending the token here, and nobody can take it back.
///
///         **The cost, stated rather than buried.** The chip records its
///         sponsor as `msg.sender`, so an edge bought through this contract
///         records *this contract* in the chip's own log, not you. A cycle you
///         want your address against is one to buy from the chip directly, and
///         that path is open to everyone and always will be. This one trades
///         that line in the log for a payment.
contract CycleRebate {
    /// @notice The token paid out.
    IERC20 public immutable TOKEN;
    /// @notice The one chip this reserve will advance.
    IChip public immutable CHIP;
    /// @notice Paid per clock edge, fixed for the life of this contract.
    uint256 public immutable RATE;

    /// @notice Edges bought through this contract, in total.
    uint256 public edges;
    /// @notice Taken out of the reserve, in total.
    uint256 public paid;

    /// @dev A transient slot, so the guard costs nothing beyond the
    ///      transaction it protects. Same mechanism the chip uses for the same
    ///      reason.
    bytes32 private constant LOCK = keccak256("stepper.rebate.lock");

    /// @param caller  Who asked for the edge and who was paid for it.
    /// @param cycle   The edge number, counting from one.
    /// @param amount  What left the reserve. Zero when it cannot cover a rate.
    event Fuelled(address indexed caller, uint256 indexed cycle, uint256 amount);

    /// @notice Two calls tried to occupy the same transaction.
    error Reentered();
    /// @notice The token refused the transfer, or lied about it.
    error TransferFailed();
    /// @notice A zero address or a zero rate would make this contract a
    ///         decoration, and there is no setter to correct it afterwards.
    error BadConfiguration();

    constructor(IERC20 token, IChip chip, uint256 rate) {
        if (address(token) == address(0)) revert BadConfiguration();
        if (address(chip) == address(0)) revert BadConfiguration();
        if (rate == 0) revert BadConfiguration();
        TOKEN = token;
        CHIP = chip;
        RATE = rate;
    }

    /// @notice Advance the chip by one clock edge and take the rebate.
    /// @param  inValue The byte the program reads with `in`.
    /// @return amount  What left the reserve. Zero if it cannot cover a rate.
    ///
    /// @dev **A short reserve never blocks a cycle.** If the balance cannot
    ///      cover the rate the edge is still taken and the rebate is zero. A
    ///      contract that reverted there would be one that stopped a chip
    ///      running because it had run out of money, which is the opposite of
    ///      the point.
    ///
    ///      **The amount recorded is what actually left.** A token may take a
    ///      fee on transfer, and a counter that recorded the intention rather
    ///      than the movement would drift from the balance for ever. This
    ///      measures.
    function fuel(uint256 inValue) external returns (uint256 amount) {
        bytes32 lock = LOCK;
        assembly {
            if tload(lock) {
                /* Reentered() */
                mstore(0x00, 0xb5dfd9e5)
                revert(0x1c, 0x04)
            }
            tstore(lock, 1)
        }

        CHIP.step(inValue);
        (uint256 cycle, , , , , ) = CHIP.snapshot();

        unchecked { edges += 1; }

        uint256 held = TOKEN.balanceOf(address(this));
        if (held >= RATE) {
            _send(msg.sender, RATE);
            uint256 left = TOKEN.balanceOf(address(this));
            amount = held - left;
            unchecked { paid += amount; }
        }

        emit Fuelled(msg.sender, cycle, amount);

        assembly { tstore(lock, 0) }
    }

    /// @notice How many more edges the reserve can pay for.
    /// @dev    Reads as zero the moment it cannot cover one, which is the
    ///         number a caller actually wants: an empty reserve still lets
    ///         `fuel()` through, it just pays nothing.
    function edgesRemaining() external view returns (uint256) {
        return TOKEN.balanceOf(address(this)) / RATE;
    }

    /// @dev A transfer that survives the tokens that do not follow the
    ///      standard: some return nothing at all, and some return false rather
    ///      than reverting. Both are treated as what they are.
    function _send(address to, uint256 value) private {
        (bool ok, bytes memory ret) = address(TOKEN).call(
            abi.encodeWithSelector(IERC20.transfer.selector, to, value)
        );
        if (!ok) revert TransferFailed();
        if (ret.length != 0 && !abi.decode(ret, (bool))) revert TransferFailed();
    }
}

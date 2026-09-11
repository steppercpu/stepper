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

/// @notice The factory, so a rebate can only be paid for a chip it made.
interface IChipRegistry {
    function idOfChip(address chip) external view returns (uint256);
}

/// @notice The reserve token.
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title  CycleRebate
/// @notice Buys a chip its next clock edge on your behalf, and pays you for
///         having asked.
///
/// @dev    A chip advances when somebody pays for the next edge, and nothing
///         about it earns: `step()` is not payable, the chip holds no balance,
///         and there is no withdrawal path anywhere in it. A processor with no
///         oscillator needs somebody to want the next edge enough to buy it.
///         This is a reserve that makes wanting it cheaper.
///
///         **What it pays for is work, never holding.** The only way to be
///         paid by this contract is to make a chip take a cycle. Holding the
///         token does nothing here, and there is no function that would let it.
///         That distinction is the whole design and not a formality: a reserve
///         that pays for work is an incentive; a reserve that pays for holding
///         is something else with a different regulator.
///
///         **Three properties fixed at construction, and none of them movable.**
///         The token, the registry and the rate are immutable. There is no
///         owner, no pause, no setter and no withdrawal function: once a token
///         is in here the only way out is through `fuel()`, to somebody who
///         advanced a chip. Nobody can empty it, including whoever deploys it.
///
///         **The cost, stated rather than buried.** The chip records its
///         sponsor as `msg.sender`, so an edge bought through this contract
///         records *this contract* in the chip's own log, not you. A cycle you
///         want your address against is a cycle you should buy from the chip
///         directly, and that path is open to everyone and always will be.
///         This one trades that line in the log for a rebate. Which is worth
///         more is not ours to decide for anybody.
contract CycleRebate {
    /// @notice The token paid out.
    IERC20 public immutable TOKEN;
    /// @notice The factory whose chips are eligible.
    IChipRegistry public immutable REGISTRY;
    /// @notice Paid per clock edge, fixed for the life of this contract.
    uint256 public immutable RATE;

    /// @notice Edges bought through this contract, in total.
    uint256 public edges;
    /// @notice Paid out, in total.
    uint256 public paid;

    /// @param caller  Who asked for the edge and who was paid for it.
    /// @param chip    The chip that advanced.
    /// @param cycle   The edge number, counting from one.
    /// @param amount  What was paid. Zero when the reserve is empty.
    event Fuelled(
        address indexed caller,
        address indexed chip,
        uint256 indexed cycle,
        uint256 amount
    );

    /// @notice The address given is not a chip this registry made.
    error NotAChip();
    /// @notice The token refused the transfer.
    error TransferFailed();
    /// @notice A zero address or a zero rate would make this contract a
    ///         decoration, and there is no setter to correct it afterwards.
    error BadConfiguration();

    constructor(IERC20 token, IChipRegistry registry, uint256 rate) {
        if (address(token) == address(0)) revert BadConfiguration();
        if (address(registry) == address(0)) revert BadConfiguration();
        if (rate == 0) revert BadConfiguration();
        TOKEN = token;
        REGISTRY = registry;
        RATE = rate;
    }

    /// @notice Advance a chip by one clock edge and take the rebate.
    /// @param  chip     The chip to advance. It must be one the registry made.
    /// @param  inValue  The byte the program reads with `in`.
    /// @return amount   What was paid. Zero if the reserve cannot cover it.
    ///
    /// @dev The registry check is not a formality. Without it, anybody could
    ///      deploy a contract whose `step()` does nothing, call this against
    ///      it for the price of the calldata, and take the reserve apart in an
    ///      afternoon. `idOfChip` answers from the factory's own records, which
    ///      cannot be written by anyone but the factory.
    ///
    ///      **A short reserve never blocks a cycle.** If the balance cannot
    ///      cover the rate the edge is still taken and the rebate is zero. A
    ///      contract that reverted here would be a contract that stopped chips
    ///      running because it had run out of money, which is the opposite of
    ///      the point.
    function fuel(address chip, uint256 inValue) external returns (uint256 amount) {
        if (REGISTRY.idOfChip(chip) == 0) revert NotAChip();

        IChip(chip).step(inValue);
        (uint256 cycle, , , , , ) = IChip(chip).snapshot();

        /* Counted before the transfer, so a token that calls back sees a state
           that is already settled. There is nothing here worth re-entering
           for -- the rebate is bounded by the balance either way -- but the
           ordering costs nothing and removes the question. */
        unchecked { edges += 1; }

        uint256 balance = TOKEN.balanceOf(address(this));
        amount = balance >= RATE ? RATE : 0;

        if (amount != 0) {
            unchecked { paid += amount; }
            if (!TOKEN.transfer(msg.sender, amount)) revert TransferFailed();
        }

        emit Fuelled(msg.sender, chip, cycle, amount);
    }

    /// @notice How many more edges the reserve can pay for.
    /// @dev    Reads as zero the moment it cannot cover one, which is the
    ///         number a caller actually wants: an empty reserve still lets
    ///         `fuel()` through, it just pays nothing.
    function edgesRemaining() external view returns (uint256) {
        return TOKEN.balanceOf(address(this)) / RATE;
    }
}

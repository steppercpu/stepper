// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {IPortDevice} from "./IBus.sol";

/// @notice The reads this device makes of a data source.
/// @dev    Named as the technical dependency it is: any contract answering
///         these two selectors can be wired to a port. Nothing beyond what the
///         conversion requires is read, and nothing is written.
interface IFeed {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint80 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @title  FeedPort
/// @notice An analogue-to-digital converter: a published quantity arriving at
///         the processor as one byte.
///
/// @dev    This is the oldest arrangement in computing and it has not changed.
///         A quantity out in the world is continuous and a processor is not,
///         so something between them picks a scale and rounds. That something
///         is this contract. It chooses the conversion and publishes the
///         conversion through `window`, so anybody holding the same readings
///         can replay the same run and get the same bytes.
///
///         **Auto-ranging, and why the window is immutable.** Eight bits are
///         two hundred and fifty six steps and no more, so where they are spent
///         is the whole design: `[lo, hi]` maps onto the full swing, and a
///         window ten times too wide throws nine tenths of the resolution away
///         on a range nothing moves in. That makes the window the most
///         valuable thing here to be able to change, which is exactly why
///         nobody can. A settable window is a dial that rewrites what the
///         processor saw, after the fact and without touching a gate.
///
///         **A stale reading is refused, not rounded.** If the source has not
///         updated inside `MAX_AGE`, `sense` reverts and the clock simply does
///         not advance. The alternative is handing the processor an old number
///         as though it were current, and between a machine that has visibly
///         stopped and a machine that is confidently wrong, only one of them
///         can be noticed. `MAX_AGE` of zero disables the check, for a source
///         that does not publish a timestamp.
///
///         **`drive` is open, and cannot be forged.** A device cannot know its
///         bus: the bus takes the device as a constructor argument, so the
///         device is the older of the two. Rather than close that loop with a
///         setter, which is an owner by another name, every caller writes only
///         its own slot. Anybody may point a bus at this device; nobody may
///         write what another bus decided. A reader who wants a particular
///         processor's output reads the slot of the bus that carries it, and
///         checks that bus with `chip()` and `device()`.
///
///         There is no owner, no pause and no upgrade path.
contract FeedPort is IPortDevice {
    /// @notice The source this device converts.
    IFeed public immutable FEED;

    /// @notice The reading that converts to 0.
    int256 public immutable LO;
    /// @notice The reading that converts to 255.
    int256 public immutable HI;
    /// @notice The fixed-point scale `LO` and `HI` are quoted in.
    /// @dev    Read off the source at construction rather than supplied, so
    ///         `window` cannot describe a scale the readings are not in.
    uint8 public immutable DECIMALS;
    /// @notice Seconds a reading may be old before it is refused. 0 disables.
    uint256 public immutable MAX_AGE;
    /// @dev    `HI - LO`, computed once at construction. Doing the subtraction
    ///         here means a window so wide that the span does not fit fails at
    ///         deployment rather than inside a `sense` that a clock depends on.
    uint256 private immutable SPAN;

    /// @notice The last byte each bus drove into this device.
    mapping(address => uint8) public lastValue;
    /// @notice How many bytes each bus has driven.
    mapping(address => uint256) public driven;

    /// @notice Emitted every time a processor puts a byte on its output port.
    /// @param  bus   The bus that drove it, and the only slot it can write.
    /// @param  value The byte, as latched.
    /// @param  count How many that bus has driven, including this one.
    event Driven(address indexed bus, uint8 value, uint256 count);

    /// @notice The source was the zero address.
    error NoFeed();
    /// @notice The window is empty or inverted.
    error BadWindow();
    /// @notice The source has not published inside MAX_AGE.
    error Stale();
    /// @notice The source answered with a round that never closed.
    error NoAnswer();

    /// @param feed   The source to convert.
    /// @param lo     The reading that becomes 0, in the source's own scale.
    /// @param hi     The reading that becomes 255, in the source's own scale.
    /// @param maxAge Seconds a reading may be old. 0 to accept any age.
    constructor(IFeed feed, int256 lo, int256 hi, uint256 maxAge) {
        if (address(feed) == address(0)) revert NoFeed();
        if (hi <= lo) revert BadWindow();
        if (uint256(hi - lo) > type(uint256).max / 255) revert BadWindow();

        FEED = feed;
        LO = lo;
        HI = hi;
        SPAN = uint256(hi - lo);
        MAX_AGE = maxAge;
        DECIMALS = feed.decimals();
    }

    /// @inheritdoc IPortDevice
    /// @dev Clamped rather than wrapped. A reading outside the window is a
    ///      reading at the end of the instrument, which is what an instrument
    ///      reports; wrapping would make the top of the range indistinguishable
    ///      from the bottom and hand the processor the opposite of the truth.
    function sense() external view returns (uint8 sample) {
        (, int256 answer, , uint256 updatedAt, ) = FEED.latestRoundData();

        if (updatedAt == 0) revert NoAnswer();

        /* A reading stamped ahead of the block is not stale, and subtracting
           it from now would panic rather than answer. Ahead of the clock is
           treated as age zero. */
        if (MAX_AGE != 0 && updatedAt < block.timestamp) {
            if (block.timestamp - updatedAt > MAX_AGE) revert Stale();
        }

        if (answer <= LO) return 0;
        if (answer >= HI) return 255;

        /* Both operands are bounded by the constructor: `answer - LO` is less
           than SPAN, and SPAN times 255 was checked to fit. So the one path
           the clock depends on has no arithmetic that can revert. */
        return uint8(uint256(answer - LO) * 255 / SPAN);
    }

    /// @inheritdoc IPortDevice
    function window() external view returns (int256 lo, int256 hi, uint8 decimals) {
        return (LO, HI, DECIMALS);
    }

    /// @inheritdoc IPortDevice
    /// @dev Records against `msg.sender`, which is the bus. See the note above
    ///      about why this is open and why that is not a hole.
    function drive(uint8 value) external {
        lastValue[msg.sender] = value;
        uint256 count;
        unchecked { count = ++driven[msg.sender]; }
        emit Driven(msg.sender, value, count);
    }
}

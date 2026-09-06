// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @title  IPortDevice
/// @notice A device sitting on the processor's I/O port.
/// @dev    The ST-8 has an input port and an output port, each a byte wide,
///         and that is the whole of its contact with the world. Everything a
///         processor has ever controlled, it controlled through a port: a
///         disk controller, a servo driver, a DAC. The processor computes and
///         drives a bus; the device on the far side of that bus does the work.
///
///         This interface is that far side. Implement it and the chip can
///         steer anything the implementation can reach.
interface IPortDevice {
    /// @notice What the input port reads on the next edge.
    /// @dev    An analogue-to-digital converter, in the sense the term has
    ///         always had: a continuous quantity arriving as a byte. The
    ///         device chooses the conversion and publishes it through
    ///         `window`, so a run can be replayed by anyone holding the same
    ///         readings.
    /// @return sample The byte the processor will see.
    function sense() external view returns (uint8 sample);

    /// @notice The conversion window the current sample was taken in.
    /// @dev    Auto-ranging, exactly as an instrument auto-ranges: the device
    ///         maps `[lo, hi]` onto the full 0-255 swing, so the eight bits
    ///         land where the movement is rather than being spent on a range
    ///         nothing trades in. A wider processor is a wider converter on
    ///         the same window, not a different design.
    /// @return lo The reading that converts to 0.
    /// @return hi The reading that converts to 255.
    /// @return decimals The fixed-point scale `lo` and `hi` are quoted in.
    function window() external view returns (int256 lo, int256 hi, uint8 decimals);

    /// @notice Act on what the processor put on its output port.
    /// @dev    Called by the bus on every edge, after the flip-flops latch.
    ///         The device owns the meaning of the byte and owns the
    ///         consequences of it; the processor owns only the decision.
    /// @param  value The output port, as latched.
    function drive(uint8 value) external;
}

/// @title  IBus
/// @notice Wires a chip to a device and clocks the pair.
/// @dev    One edge is: convert, present, run the gates, latch, drive. That
///         is the fetch-execute cycle of every processor with a peripheral
///         hanging off it, and the reason this contract exists rather than
///         the logic living inside the chip is the same reason a CPU die does
///         not contain the disk: the part that computes and the part that
///         touches the world have different lifetimes and different trust.
///
///         A chip can be moved to another device. A device can be replaced
///         without refabricating the chip. Neither can silently become the
///         other.
interface IBus {
    /// @notice Emitted once per edge.
    /// @param  sponsor The address that paid for the edge.
    /// @param  cycle   The chip's cycle count after it.
    /// @param  sample  The byte presented to the input port.
    /// @param  value   The byte the output port latched.
    event Edge(address indexed sponsor, uint40 indexed cycle, uint8 sample, uint8 value);

    /// @notice Emitted when the device is changed.
    event DeviceSet(address indexed from, address indexed to);

    /// @notice The processor on this bus.
    function chip() external view returns (address);

    /// @notice The device on the far side of the port.
    function device() external view returns (IPortDevice);

    /// @notice Advance the pair one edge.
    /// @dev    Open to anyone, on the same terms as the chip's own `step`:
    ///         the caller pays for the edge and is recorded as having driven
    ///         it. There is no schedule and no keeper, because a clock that
    ///         belongs to somebody is a clock they can stop.
    /// @return sample The byte the input port read.
    /// @return value  The byte the output port drove.
    function tick() external returns (uint8 sample, uint8 value);

    /// @notice What the next edge would do, without taking it.
    /// @dev    The whole point of a structural machine: the answer is a
    ///         consequence of the gate table, so it can be computed before
    ///         it is committed to and checked against what lands.
    function preview() external view returns (uint8 sample, uint8 value);
}

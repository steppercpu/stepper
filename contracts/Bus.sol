// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Spec} from "./IGateArray.sol";
import {IBus, IPortDevice} from "./IBus.sol";
import {Machine} from "./Machine.sol";

/// @notice The reads a bus needs from the chip it clocks.
/// @dev    Everything here is either immutable on the chip or a view of its
///         storage, so a bus can describe the next edge without being trusted
///         about any of it.
interface IChipPort {
    function ARRAY() external view returns (address);
    function ROM() external view returns (address);
    function ROM_WORDS() external view returns (uint32);
    function spec() external view returns (Spec memory);
    function state() external view returns (uint256[] memory);
    function ram(uint256 a) external view returns (uint256);
    function snapshot()
        external
        view
        returns (uint256 cycle, uint256 pc, uint256 outPort, bool carry, bool zero, bool halted);
    function step(uint256 inValue) external;
}

/// @notice The gate array, which is pure and therefore safe to ask twice.
interface IGateArrayStep {
    function step(uint256[] calldata state, uint256[] calldata inputs)
        external
        pure
        returns (uint256[] memory);
}

/// @title  Bus
/// @notice A chip wired to a device, and a clock anyone may advance.
///
/// @dev    One edge is: convert, present, run the gates, latch, drive. The
///         chip owns the decision and the device owns the consequences, which
///         is the arrangement every processor with a peripheral hanging off it
///         has ever had.
///
///         **The device is immutable, and that is the security property.**
///         `IBus` says a device may be replaced without refabricating the
///         chip, and it may: deploy another bus, and the chip is untouched,
///         because the chip has no idea a bus exists. What there is no way to
///         do is change the device under an existing bus. A settable device
///         would need an owner, and that owner could change what the processor
///         senses and what its output drives, every byte in and every byte
///         out, without touching a gate. So `DeviceSet` is emitted once, from
///         the constructor, as the record of the wiring rather than as a thing
///         that can happen again.
///
///         **sense() cannot reenter and drive() can.** `sense` is a view in
///         `IPortDevice`, so the compiler reaches it with STATICCALL and a
///         device cannot write state from inside it, let alone call back.
///         `drive` is not a view, because the whole point of it is that the
///         device acts, so it is a live call to an address chosen at
///         construction and `tick` is guarded against being reentered through
///         it. The guard is transient: it costs a TSTORE and clears itself at
///         the end of the transaction.
///
///         **The chip records the bus, not the caller.** A chip emits the
///         address that called `step`, which through here is this contract.
///         The sponsor who actually paid is in this contract's `Edge` event,
///         and a reader reconstructing who drove a chip needs both.
///
///         There is no owner, no pause, no upgrade path and no privileged
///         caller. Nothing here is payable and nothing here holds a balance.
contract Bus is IBus {
    /// @dev Both fixed at construction. See the note above about why the
    ///      device in particular is not settable.
    address private immutable _chip;
    IPortDevice private immutable _device;

    /// @dev Read once at construction rather than on every edge.
    address private immutable _array;
    address private immutable _rom;
    uint256 private immutable _romWords;
    uint256 private immutable _outOffset;
    uint256 private immutable _outBits;

    /// @dev Transient reentrancy flag, cleared at the end of the transaction.
    bytes32 private constant LOCK = keccak256("stepper.bus.lock");

    /// @notice The chip or the device was the zero address.
    error NotWired();
    /// @notice This chip does not fit the byte-wide bus that `IBus` describes.
    error UnsupportedPort();
    /// @notice tick() was reentered, which a device can only attempt from
    ///         inside drive().
    error Reentered();
    /// @notice The processor has halted, so there is no next edge.
    error Halted();
    /// @notice The gate array returned a state of the wrong shape.
    error BadReturn();

    /// @param chip_   The processor this bus clocks.
    /// @param device_ The device on the far side of the port, permanently.
    ///
    /// @dev The port widths are checked here rather than trusted, because
    ///      `IBus` carries bytes and a chip is not obliged to. A processor
    ///      whose output port is wider than eight bits would have its top bits
    ///      dropped on the way to `drive`, and the device would then act on a
    ///      number the processor never produced. That is refused rather than
    ///      truncated. A wider bus for a wider processor is a different
    ///      interface, not a quieter version of this one.
    constructor(address chip_, IPortDevice device_) {
        if (chip_ == address(0) || address(device_) == address(0)) revert NotWired();

        Spec memory s = IChipPort(chip_).spec();
        if (s.outBits > 8) revert UnsupportedPort();
        if (s.dataBits < 8) revert UnsupportedPort();

        _chip = chip_;
        _device = device_;
        _array = IChipPort(chip_).ARRAY();
        _rom = IChipPort(chip_).ROM();
        _romWords = IChipPort(chip_).ROM_WORDS();
        _outOffset = s.outOffset;
        _outBits = s.outBits;

        emit DeviceSet(address(0), address(device_));
    }

    /// @inheritdoc IBus
    function chip() external view returns (address) {
        return _chip;
    }

    /// @inheritdoc IBus
    function device() external view returns (IPortDevice) {
        return _device;
    }

    /// @inheritdoc IBus
    function tick() external returns (uint8 sample, uint8 value) {
        bytes32 lock = LOCK;
        assembly {
            if tload(lock) {
                mstore(0x00, 0xb5dfd9e5)
                revert(0x1c, 0x04)
            }
            tstore(lock, 1)
        }

        IChipPort c = IChipPort(_chip);

        /* Convert and present. A view, so the device cannot reach back in. */
        sample = _device.sense();

        /* Run the gates and latch. The chip refuses a halted machine itself,
           so there is no second halt check here to disagree with it. */
        c.step(sample);

        /* Read what latched rather than what the gates were predicted to
           produce: the port is whatever the chip now says it is. */
        (uint256 cycle, , uint256 outPort, , , ) = c.snapshot();
        value = uint8(outPort);

        /* Drive, last. Everything above is already committed, so a device that
           reverts here takes the edge with it, which is the right outcome for
           a device that cannot accept what the processor decided. */
        _device.drive(value);

        emit Edge(msg.sender, uint40(cycle), sample, value);

        assembly { tstore(lock, 0) }
    }

    /// @inheritdoc IBus
    /// @dev Recomputes the edge from the chip state, the ROM word at the
    ///      program counter, and the one RAM cell the pre-state addresses:
    ///      the same three things the chip will hand the gates. The output
    ///      field is then read out of the result.
    ///
    ///      Only one cell of RAM is read because only one is needed. The gate
    ///      array is a pure function of the state and the driven inputs, and
    ///      RAM reaches it as a single word of read data. A preview that
    ///      assembled the whole of memory would be doing two hundred and
    ///      fifty six reads in order to use one of them.
    function preview() external view returns (uint8 sample, uint8 value) {
        IChipPort c = IChipPort(_chip);
        Spec memory s = c.spec();

        uint256[] memory q = Machine.strip(s, c.state());
        if (Machine.bit(q, s.haltBit) == 1) revert Halted();

        sample = _device.sense();

        uint256 at = Machine.field(q, s.pcOffset, s.pcBits);
        uint256 rdata = c.ram(Machine.field(q, s.ramAddrOffset, s.ramAddrBits));

        uint256[] memory next = IGateArrayStep(_array).step(
            q, Machine.inputs(s, Machine.romWord(_rom, _romWords, at), sample, rdata)
        );
        if (next.length != s.stateWords) revert BadReturn();

        value = uint8(Machine.field(next, _outOffset, _outBits));
    }
}

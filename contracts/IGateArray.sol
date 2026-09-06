// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @title  Spec
/// @notice Immutable description of one generation of STEPPER silicon.
/// @dev    Bit offsets are counted from bit 0 of state word 0 and spill into
///         the next word every 256 bits. Every field described here is
///         contiguous; the build refuses to emit a netlist where it is not.
struct Spec {
    /// @dev NAND gates in the combinational cone.
    uint16 gates;
    /// @dev Flip-flops, and therefore the width of the architectural state.
    uint16 flops;
    /// @dev Nets, including the constant-high net.
    uint16 nets;
    /// @dev Datapath width in bits.
    uint8 dataBits;
    /// @dev ceil(flops / 256).
    uint8 stateWords;
    /// @dev ceil((instrBits + 2 * dataBits) / 256).
    uint8 inputWords;
    /// @dev Width of one instruction word.
    uint16 instrBits;
    /// @dev Addressable ROM words.
    uint32 romWords;
    /// @dev Addressable RAM in bytes.
    uint32 ramBytes;
    /// @dev Registers in the file.
    uint8 regCount;
    /// @dev Register k occupies [regsOffset + k * dataBits, + dataBits).
    uint16 regsOffset;
    uint16 pcOffset;
    uint8 pcBits;
    uint16 outOffset;
    uint8 outBits;
    uint16 ramAddrOffset;
    uint8 ramAddrBits;
    uint16 ramWdataOffset;
    uint8 ramWdataBits;
    uint16 haltBit;
    uint16 carryBit;
    uint16 zeroBit;
    uint16 ramWeBit;
}

/// @title  IGateArray
/// @notice One generation of STEPPER silicon: a combinational cone and a
///         latch, evaluated as a pure function.
/// @dev    Implementations are stateless and ownerless. They cannot be
///         upgraded, paused or reconfigured after deployment. A later
///         generation is a new deployment at a new address, never a change to
///         an existing one.
///
///         ROM and RAM are outside this interface by design, so a chip, a
///         batch runner or a fraud proof may each supply their own.
interface IGateArray {
    /// @notice Immutable description of this silicon.
    function spec() external pure returns (Spec memory);

    /// @notice Advance the flip-flops by one clock edge.
    /// @param  state  Flip-flop values, one per bit, little-endian across
    ///                exactly `spec().stateWords` words.
    /// @param  inputs Driven inputs packed little-endian in this order: the
    ///                instruction word, the input port, then RAM read data.
    ///                Exactly `spec().inputWords` words.
    /// @return next   Flip-flop values after the edge, in the shape of `state`.
    function step(uint256[] calldata state, uint256[] calldata inputs)
        external
        pure
        returns (uint256[] memory next);
}

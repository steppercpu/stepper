// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Spec} from "./IGateArray.sol";

/// @title  Machine
/// @notice How a machine state is taken apart, written once.
/// @dev    A chip, a verifier and a bus all have to read the same flip-flop
///         vector the same way: the program counter out of one field, the RAM
///         address out of another, a cell out of a packed word. Each of those
///         is a shift and a mask, and each field is contiguous only because
///         the build refuses to emit a netlist where it is not.
///
///         The arithmetic lives here rather than being written again in each
///         caller because a second way of reading the same bytes is a second
///         thing that can be wrong, and two copies would disagree in exactly
///         the case nobody thinks to test: a field that straddles a word
///         boundary.
///
///         Every function is `internal`, so this is inlined into its callers
///         and adds no deployment and no call.
library Machine {
    /// @notice Bit position of the cycle counter inside the last state word.
    /// @dev    The counter sits above every architectural bit, so the shift is
    ///         the number of flip-flops that live in the last word.
    function cycleShift(Spec memory s) internal pure returns (uint256) {
        return uint256(s.flops) - (uint256(s.stateWords) - 1) * 256;
    }

    /// @notice A mask of `bits` low bits, which does not overflow at 256.
    function mask(uint256 bits) internal pure returns (uint256) {
        return bits >= 256 ? type(uint256).max : (uint256(1) << bits) - 1;
    }

    /// @notice One flip-flop.
    function bit(uint256[] memory v, uint256 i) internal pure returns (uint256) {
        return (v[i / 256] >> (i % 256)) & 1;
    }

    /// @notice One field of the state.
    /// @dev    A field may straddle two words, which is why this is not one
    ///         shift.
    function field(uint256[] memory v, uint256 offset, uint256 bits)
        internal
        pure
        returns (uint256 out)
    {
        uint256 w = offset / 256;
        uint256 b = offset % 256;
        out = v[w] >> b;
        if (b + bits > 256) out |= v[w + 1] << (256 - b);
        out &= mask(bits);
    }

    /// @notice A copy of `state` with the cycle counter masked away.
    /// @dev    The gates never see the counter. Masking rather than rejecting
    ///         keeps a caller who passed a raw `state()` result from getting a
    ///         wrong answer.
    function strip(Spec memory s, uint256[] memory state)
        internal
        pure
        returns (uint256[] memory q)
    {
        q = new uint256[](state.length);
        for (uint256 i = 0; i < state.length; ++i) q[i] = state[i];
        q[q.length - 1] &= (uint256(1) << cycleShift(s)) - 1;
    }

    /// @notice The driven inputs, packed in the order the gate array expects.
    function inputs(Spec memory s, uint256 instr, uint256 inValue, uint256 rdata)
        internal
        pure
        returns (uint256[] memory packed)
    {
        packed = new uint256[](s.inputWords);
        packed[0] = instr
            | (inValue << s.instrBits)
            | (rdata << (uint256(s.instrBits) + uint256(s.dataBits)));
    }

    /// @notice One ROM word.
    /// @dev    The ROM is contract code, four big-endian bytes a word, one byte
    ///         in. Read the way the chip reads it, because a second way of
    ///         reading the same bytes is a second thing that can be wrong.
    function romWord(address src, uint256 words, uint256 at)
        internal
        view
        returns (uint256 word)
    {
        if (at >= words) return 0;
        assembly {
            let p := mload(0x40)
            mstore(p, 0)
            extcodecopy(src, add(p, 28), add(1, mul(at, 4)), 4)
            word := mload(p)
        }
    }

    /// @notice RAM cells packed to a word.
    function perWord(Spec memory s) internal pure returns (uint256) {
        return 256 / uint256(s.ramWdataBits);
    }

    /// @notice Words needed to hold every addressable cell.
    function ramWords(Spec memory s) internal pure returns (uint256) {
        uint256 cells = uint256(1) << s.ramAddrBits;
        uint256 per = perWord(s);
        return (cells + per - 1) / per;
    }

    /// @notice One cell out of a packed RAM image.
    function readRam(Spec memory s, uint256[] memory ram, uint256 a)
        internal
        pure
        returns (uint256)
    {
        uint256 per = perWord(s);
        if (a / per >= ram.length) return 0;
        return (ram[a / per] >> ((a % per) * s.ramWdataBits)) & mask(s.ramWdataBits);
    }

    /// @notice One cell into a packed RAM image.
    function writeRam(Spec memory s, uint256[] memory ram, uint256 a, uint256 v)
        internal
        pure
    {
        uint256 per = perWord(s);
        if (a / per >= ram.length) return;
        uint256 shift = (a % per) * s.ramWdataBits;
        uint256 m = mask(s.ramWdataBits) << shift;
        ram[a / per] = (ram[a / per] & ~m) | ((v << shift) & m);
    }
}

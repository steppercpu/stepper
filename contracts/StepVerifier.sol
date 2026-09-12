// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Spec} from "./IGateArray.sol";

/// @notice The silicon, evaluated as a pure function of a supplied state.
interface IGateArrayStep {
    function step(uint256[] calldata state, uint256[] calldata inputs)
        external
        pure
        returns (uint256[] memory);
}

/// @notice What a chip tells the outside world about itself.
/// @dev    All of this is immutable on the chip, so a transition computed from
///         it is a transition about that chip specifically and cannot be made
///         to describe a different machine.
interface IChipFacts {
    function ARRAY() external view returns (address);
    function ROM() external view returns (address);
    function ROM_WORDS() external view returns (uint32);
    function spec() external view returns (Spec memory);
}

/// @title  StepVerifier
/// @notice One clock edge, recomputed on chain from a machine state somebody
///         hands it, rather than from a chip's own storage.
///
/// @dev    This is the settlement primitive a fraud proof is built on, and it
///         exists because `IGateArray` was written to allow it: ROM and RAM sit
///         outside that interface on purpose, so a chip, a batch runner or a
///         proof may each supply their own.
///
///         **Why a court needs this and `Chip.step()` will not do.** A chip
///         advances its own stored state. It cannot answer the question a
///         dispute actually asks, which is hypothetical: given this state,
///         which may never have existed, and this input, what comes next? That
///         question has to be answerable about a state nobody has committed
///         to storage, or a challenge can only ever be made about the present.
///
///         **What is not here.** Bonds, claims, challenge windows and the
///         bisection that narrows a disputed range of cycles down to one. Those
///         are bookkeeping above this line, and they are worth nothing without
///         it. This contract is the part that has to be right.
///
///         **A machine state is two things.** The flip-flop vector and the RAM.
///         The gate array only knows about the first, and a transition that
///         ignored the second would agree with the chip until the first store
///         instruction and never again. Both are arguments here and both come
///         back.
///
///         There is no owner, no storage and nothing payable. Every function is
///         a view, so being wrong here costs a caller gas and nothing else.
contract StepVerifier {
    /// @notice The supplied state is not `spec().stateWords` long.
    error BadStateLength();
    /// @notice The supplied RAM is not the shape this chip's RAM has.
    error BadRamLength();
    /// @notice The gate array returned a state of the wrong shape.
    error BadReturn();
    /// @notice The machine has halted, so there is no next edge to compute.
    error Halted();
    /// @notice The input does not fit the datapath width.
    error InputTooWide();

    /// @notice Recompute one clock edge.
    /// @param  chip    The chip whose silicon and ROM define the transition.
    /// @param  state   Flip-flop values, architectural only. See the note below
    ///                 about the cycle counter.
    /// @param  ram     The whole of RAM, packed the way the chip packs it:
    ///                 `256 / spec().ramWdataBits` cells to a word.
    /// @param  inValue The byte the sponsor supplies to the input port.
    /// @return next    Flip-flops after the edge, in the shape of `state`.
    /// @return nextRam RAM after the edge. Identical to `ram` unless the edge
    ///                 wrote to it.
    ///
    /// @dev Three details decide whether this agrees with the chip, and all
    ///      three are easy to get backwards.
    ///
    ///      **The cycle counter is not part of the state.** A chip keeps it in
    ///      the high bits of the last state word and strips it before handing
    ///      the vector to the gates. The argument here is the stripped vector,
    ///      because that is what the silicon sees. A caller who leaves a cycle
    ///      count in the top bits is describing a different machine, and the
    ///      counter is masked off below rather than trusted.
    ///
    ///      **The RAM read address comes from the state before the edge.** The
    ///      write address comes from the state after it. They are usually the
    ///      same and they are not always, and a verifier that used one for both
    ///      would agree with the chip on every program that never reads and
    ///      writes different cells in one instruction.
    ///
    ///      **A halted machine has no next edge.** The chip refuses; so does
    ///      this, and for the same reason: a transition out of a halt is not a
    ///      transition anybody can disagree about.
    function transition(
        address chip,
        uint256[] memory state,
        uint256[] memory ram,
        uint256 inValue
    ) public view returns (uint256[] memory next, uint256[] memory nextRam) {
        Spec memory s = IChipFacts(chip).spec();

        if (state.length != s.stateWords) revert BadStateLength();
        if (ram.length != _ramWords(s)) revert BadRamLength();
        if (inValue > _mask(s.dataBits)) revert InputTooWide();
        if (_bit(state, s.haltBit) == 1) revert Halted();

        /* The counter lives above the architectural bits of the last word and
           the gates never see it. Masking rather than rejecting keeps a caller
           who passed a raw `state()` result from getting a wrong answer. */
        uint256[] memory q = new uint256[](state.length);
        for (uint256 i = 0; i < state.length; ++i) q[i] = state[i];
        q[q.length - 1] &= (uint256(1) << _cycleShift(s)) - 1;

        uint256 at = _field(q, s.pcOffset, s.pcBits);
        uint256 rdata = _read(s, ram, _field(q, s.ramAddrOffset, s.ramAddrBits));

        next = IGateArrayStep(IChipFacts(chip).ARRAY()).step(
            q, _inputs(s, _rom(chip, at), inValue, rdata)
        );
        if (next.length != s.stateWords) revert BadReturn();

        /* Copied rather than aliased. The caller's array is theirs, and a
           verifier that edited it would be answering a question by changing
           the thing that was asked about. */
        nextRam = new uint256[](ram.length);
        for (uint256 i = 0; i < ram.length; ++i) nextRam[i] = ram[i];

        if (_bit(next, s.ramWeBit) == 1) {
            _write(
                s,
                nextRam,
                _field(next, s.ramAddrOffset, s.ramAddrBits),
                _field(next, s.ramWdataOffset, s.ramWdataBits)
            );
        }
    }

    /// @notice A commitment to a whole machine state.
    /// @dev    Flip-flops and RAM together, because either alone describes half
    ///         a machine. A claim about a run commits to one of these per step
    ///         and a dispute is a disagreement about which one is right.
    function commit(uint256[] memory state, uint256[] memory ram)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(state, ram));
    }

    /// @notice Whether a claimed next state is the one the gates produce.
    /// @dev    The whole of a settlement, once a dispute has been narrowed to a
    ///         single edge. Reverting cases answer false rather than reverting,
    ///         so that a caller settling a dispute gets a verdict rather than a
    ///         failed transaction: a claim about a halted machine or a
    ///         malformed state is a wrong claim, not an unanswerable one.
    function agrees(
        address chip,
        uint256[] memory state,
        uint256[] memory ram,
        uint256 inValue,
        bytes32 claimed
    ) external view returns (bool) {
        try this.transition(chip, state, ram, inValue) returns (
            uint256[] memory next,
            uint256[] memory nextRam
        ) {
            return commit(next, nextRam) == claimed;
        } catch {
            return false;
        }
    }

    /* ------------------------------------------------------------- fields */

    /// @dev The counter sits above every architectural bit, so the shift is the
    ///      number of flip-flops that live in the last word.
    function _cycleShift(Spec memory s) private pure returns (uint256) {
        uint256 inLast = uint256(s.flops) - (uint256(s.stateWords) - 1) * 256;
        return inLast;
    }

    function _mask(uint256 bits) private pure returns (uint256) {
        return bits >= 256 ? type(uint256).max : (uint256(1) << bits) - 1;
    }

    function _bit(uint256[] memory v, uint256 i) private pure returns (uint256) {
        return (v[i / 256] >> (i % 256)) & 1;
    }

    /// @dev A field may straddle two words, which is why this is not one shift.
    function _field(uint256[] memory v, uint256 offset, uint256 bits)
        private
        pure
        returns (uint256 out)
    {
        uint256 w = offset / 256;
        uint256 b = offset % 256;
        out = v[w] >> b;
        if (b + bits > 256) out |= v[w + 1] << (256 - b);
        out &= _mask(bits);
    }

    function _inputs(Spec memory s, uint256 instr, uint256 inValue, uint256 rdata)
        private
        pure
        returns (uint256[] memory packed)
    {
        packed = new uint256[](s.inputWords);
        packed[0] = instr
            | (inValue << s.instrBits)
            | (rdata << (uint256(s.instrBits) + uint256(s.dataBits)));
    }

    /* ---------------------------------------------------------- ROM and RAM */

    /// @dev The ROM is contract code, four big-endian bytes a word, one byte in.
    ///      Read the way the chip reads it, because a second way of reading the
    ///      same bytes is a second thing that can be wrong.
    function _rom(address chip, uint256 at) private view returns (uint256 word) {
        if (at >= IChipFacts(chip).ROM_WORDS()) return 0;
        address src = IChipFacts(chip).ROM();
        assembly {
            let p := mload(0x40)
            mstore(p, 0)
            extcodecopy(src, add(p, 28), add(1, mul(at, 4)), 4)
            word := mload(p)
        }
    }

    /// @dev Cells to a word, and words to hold every addressable cell. Both
    ///      follow from the spec, so a chip of any generation is described by
    ///      the same two lines.
    function _perWord(Spec memory s) private pure returns (uint256) {
        return 256 / uint256(s.ramWdataBits);
    }

    function _ramWords(Spec memory s) private pure returns (uint256) {
        uint256 cells = uint256(1) << s.ramAddrBits;
        uint256 per = _perWord(s);
        return (cells + per - 1) / per;
    }

    function _read(Spec memory s, uint256[] memory ram, uint256 a)
        private
        pure
        returns (uint256)
    {
        uint256 per = _perWord(s);
        if (a / per >= ram.length) return 0;
        return (ram[a / per] >> ((a % per) * s.ramWdataBits)) & _mask(s.ramWdataBits);
    }

    function _write(Spec memory s, uint256[] memory ram, uint256 a, uint256 v)
        private
        pure
    {
        uint256 per = _perWord(s);
        if (a / per >= ram.length) return;
        uint256 shift = (a % per) * s.ramWdataBits;
        uint256 m = _mask(s.ramWdataBits) << shift;
        ram[a / per] = (ram[a / per] & ~m) | ((v << shift) & m);
    }
}

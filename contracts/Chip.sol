// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {IGateArray, Spec} from "./IGateArray.sol";

/// @title  Chip
/// @notice A processor running on chain: a program in ROM, its own RAM, and a
///         clock that anyone may advance by paying for the next edge.
/// @dev    Generation-agnostic. Every width, layout and size is read from
///         `IGateArray.spec()` at construction and stored as an immutable, so
///         the same contract serves ST-8, ST-16 and every later generation
///         without modification.
///
///         There is no owner, no pause, no upgrade path and no privileged
///         caller. `step` is open to every address and reverts only when the
///         processor has halted, when the value does not fit the datapath, or
///         when it is re-entered.
contract Chip {
    /// @notice The silicon this chip runs on.
    IGateArray public immutable ARRAY;

    /// @notice Contract holding this chip's ROM, written once at construction.
    /// @dev    SSTORE2: the program is stored as contract code, which costs
    ///         200 gas per byte to write and one EXTCODECOPY to read.
    address public immutable ROM;

    /// @notice Words of ROM actually written. Addresses beyond it read as nop.
    uint32 public immutable ROM_WORDS;

    uint256 private immutable STATE_WORDS;
    uint256 private immutable INPUT_WORDS;
    uint256 private immutable INSTR_BITS;
    uint256 private immutable DATA_BITS;
    uint256 private immutable DATA_MASK;
    uint256 private immutable RAM_CELLS;
    uint256 private immutable RAM_CELL_BITS;
    uint256 private immutable RAM_CELL_MASK;
    uint256 private immutable RAM_PER_WORD;
    uint256 private immutable REG_COUNT;

    uint256 private immutable REGS_OFFSET;
    uint256 private immutable PC_OFFSET;
    uint256 private immutable PC_MASK;
    uint256 private immutable OUT_OFFSET;
    uint256 private immutable OUT_MASK;
    uint256 private immutable RAMADDR_OFFSET;
    uint256 private immutable RAMADDR_MASK;
    uint256 private immutable RAMW_OFFSET;
    uint256 private immutable RAMW_MASK;
    uint256 private immutable HALT_BIT;
    uint256 private immutable CARRY_BIT;
    uint256 private immutable ZERO_BIT;
    uint256 private immutable RAMWE_BIT;

    /// @dev Transient reentrancy flag. Cleared automatically at the end of
    ///      the transaction, so it costs a TSTORE rather than an SSTORE.
    bytes32 private constant LOCK = keccak256("stepper.chip.lock");

    /// @dev Bit position of the cycle counter inside the last state word.
    uint256 private immutable CYCLE_SHIFT;
    uint256 private constant CYCLE_BITS = 40;
    uint256 private constant CYCLE_MAX = (uint256(1) << CYCLE_BITS) - 1;

    /// @dev Architectural state. Word i holds flip-flops [256i, 256i + 256).
    ///      The cycle counter occupies the free high bits of the last word.
    uint256[8] private _state;

    /// @dev RAM, packed RAM_PER_WORD cells to a word.
    mapping(uint256 => uint256) private _ram;

    /// @notice Emitted once per clock edge.
    /// @param  sponsor The address that paid for the edge.
    /// @param  cycle   The edge number, counting from one.
    /// @param  outPort The output port after the edge.
    /// @param  inValue The value the sponsor supplied to the input port.
    event Stepped(address indexed sponsor, uint40 indexed cycle, uint256 outPort, uint256 inValue);

    /// @notice The processor has halted and cannot advance.
    error Halted();
    /// @notice The supplied value does not fit the datapath width.
    error InputTooWide();
    /// @notice The gate array does not fit this contract's storage layout.
    error UnsupportedSpec();
    /// @notice The ROM could not be written at construction.
    error RomWriteFailed();
    /// @notice The gate array returned a state of the wrong length.
    error BadReturn();
    /// @notice step() was re-entered.
    error Reentrant();

    /// @param array The gate array this chip runs on.
    /// @param rom   The program, four bytes per word, big-endian per word.
    constructor(IGateArray array, bytes memory rom) {
        Spec memory s = array.spec();

        if (s.stateWords == 0 || s.stateWords > 8) revert UnsupportedSpec();
        if (s.inputWords == 0 || s.inputWords > 4) revert UnsupportedSpec();
        if (s.dataBits == 0 || s.dataBits > 128) revert UnsupportedSpec();

        uint256 tail = uint256(s.flops) - (uint256(s.stateWords) - 1) * 256;
        if (tail + CYCLE_BITS > 256) revert UnsupportedSpec();

        ARRAY = array;
        STATE_WORDS = s.stateWords;
        INPUT_WORDS = s.inputWords;
        INSTR_BITS = s.instrBits;
        DATA_BITS = s.dataBits;
        DATA_MASK = (uint256(1) << s.dataBits) - 1;
        if (s.ramWdataBits == 0 || 256 % s.ramWdataBits != 0) revert UnsupportedSpec();
        RAM_CELLS = uint256(1) << s.ramAddrBits;
        RAM_CELL_BITS = s.ramWdataBits;
        RAM_CELL_MASK = (uint256(1) << s.ramWdataBits) - 1;
        RAM_PER_WORD = 256 / s.ramWdataBits;
        REG_COUNT = s.regCount;

        REGS_OFFSET = s.regsOffset;
        PC_OFFSET = s.pcOffset;
        PC_MASK = (uint256(1) << s.pcBits) - 1;
        OUT_OFFSET = s.outOffset;
        OUT_MASK = (uint256(1) << s.outBits) - 1;
        RAMADDR_OFFSET = s.ramAddrOffset;
        RAMADDR_MASK = (uint256(1) << s.ramAddrBits) - 1;
        RAMW_OFFSET = s.ramWdataOffset;
        RAMW_MASK = (uint256(1) << s.ramWdataBits) - 1;
        HALT_BIT = s.haltBit;
        CARRY_BIT = s.carryBit;
        ZERO_BIT = s.zeroBit;
        RAMWE_BIT = s.ramWeBit;

        CYCLE_SHIFT = tail;

        uint32 words = uint32(rom.length / 4);
        if (words > s.romWords) revert UnsupportedSpec();
        ROM_WORDS = words;
        ROM = _writeRom(rom);
    }

    /// @notice Advance the processor by one clock edge.
    /// @dev    Open to every address. There is no owner check, no keeper and
    ///         no schedule; the only thing between this chip and its next
    ///         cycle is somebody deciding it is worth the gas.
    /// @param  inValue The value the program reads with `in`.
    function step(uint256 inValue) external {
        bytes32 lock = LOCK;
        assembly {
            if tload(lock) {
                mstore(0x00, 0xed3ba6a6)
                revert(0x1c, 0x04)
            }
            tstore(lock, 1)
        }

        if (inValue > DATA_MASK) revert InputTooWide();

        uint256 words = STATE_WORDS;
        uint256 last = words - 1;
        uint256 shift = CYCLE_SHIFT;

        uint256[] memory q = new uint256[](words);
        for (uint256 i = 0; i < words; ++i) q[i] = _state[i];

        uint256 cycle = q[last] >> shift;
        q[last] &= (uint256(1) << shift) - 1;

        if (_bit(q, HALT_BIT) == 1) revert Halted();

        uint256 at = _field(q, PC_OFFSET, PC_MASK);
        uint256 addr = _field(q, RAMADDR_OFFSET, RAMADDR_MASK);

        uint256[] memory next = ARRAY.step(q, _inputs(_rom(at), inValue, _ramRead(addr)));
        if (next.length != words) revert BadReturn();

        if (_bit(next, RAMWE_BIT) == 1) {
            _ramWrite(
                _field(next, RAMADDR_OFFSET, RAMADDR_MASK),
                _field(next, RAMW_OFFSET, RAMW_MASK)
            );
        }

        unchecked {
            cycle = cycle == CYCLE_MAX ? CYCLE_MAX : cycle + 1;
        }
        next[last] |= cycle << shift;
        for (uint256 i = 0; i < words; ++i) _state[i] = next[i];

        emit Stepped(msg.sender, uint40(cycle), _field(next, OUT_OFFSET, OUT_MASK), inValue);

        assembly { tstore(lock, 0) }
    }

    /// @notice Everything a reader needs, in one call.
    /// @return cycle   Edges executed so far.
    /// @return pc      The program counter.
    /// @return outPort The output port.
    /// @return carry   The carry flag.
    /// @return zero    The zero flag.
    /// @return halted  Whether the processor has stopped.
    function snapshot()
        external
        view
        returns (uint256 cycle, uint256 pc, uint256 outPort, bool carry, bool zero, bool halted)
    {
        uint256[] memory s = _read();
        cycle = _cycle(s);
        pc = _field(s, PC_OFFSET, PC_MASK);
        outPort = _field(s, OUT_OFFSET, OUT_MASK);
        carry = _bit(s, CARRY_BIT) == 1;
        zero = _bit(s, ZERO_BIT) == 1;
        halted = _bit(s, HALT_BIT) == 1;
    }

    /// @notice The register file.
    function registers() external view returns (uint256[] memory r) {
        uint256[] memory s = _read();
        uint256 n = REG_COUNT;
        uint256 w = DATA_BITS;
        uint256 mask = DATA_MASK;
        r = new uint256[](n);
        for (uint256 i = 0; i < n; ++i) r[i] = _field(s, REGS_OFFSET + i * w, mask);
    }

    /// @notice One cell of RAM. A cell is `spec().ramWdataBits` wide.
    function ram(uint256 a) external view returns (uint256) {
        return _ramRead(a % RAM_CELLS);
    }

    /// @notice The raw flip-flop vector, with the cycle counter removed.
    function state() external view returns (uint256[] memory) {
        return _read();
    }

    /// @notice The program this chip carries.
    function program() external view returns (bytes memory) {
        uint256 n = uint256(ROM_WORDS) * 4;
        bytes memory out = new bytes(n);
        address src = ROM;
        assembly {
            extcodecopy(src, add(out, 32), 1, n)
        }
        return out;
    }

    /// @notice The specification of the silicon this chip runs on.
    function spec() external view returns (Spec memory) {
        return ARRAY.spec();
    }

    function _read() private view returns (uint256[] memory s) {
        uint256 words = STATE_WORDS;
        uint256 last = words - 1;
        s = new uint256[](words);
        for (uint256 i = 0; i < words; ++i) s[i] = _state[i];
        s[last] &= (uint256(1) << CYCLE_SHIFT) - 1;
    }

    function _cycle(uint256[] memory) private view returns (uint256) {
        return _state[STATE_WORDS - 1] >> CYCLE_SHIFT;
    }

    function _bit(uint256[] memory s, uint256 b) private pure returns (uint256) {
        return (s[b >> 8] >> (b & 255)) & 1;
    }

    /// @dev Reads a field that may straddle a word boundary.
    function _field(uint256[] memory s, uint256 offset, uint256 mask)
        private
        pure
        returns (uint256 v)
    {
        uint256 w = offset >> 8;
        uint256 sh = offset & 255;
        v = (s[w] >> sh) & mask;
        if (sh != 0 && w + 1 < s.length) {
            v |= (s[w + 1] << (256 - sh)) & mask;
        }
    }

    function _inputs(uint256 instr, uint256 inValue, uint256 rdata)
        private
        view
        returns (uint256[] memory packed)
    {
        packed = new uint256[](INPUT_WORDS);
        uint256 bits = INSTR_BITS;
        uint256 w = DATA_BITS;
        uint256 v = instr | (inValue << bits) | (rdata << (bits + w));
        packed[0] = v;
    }

    /// @dev The argument is not named `pc`: inside an assembly block that name
    ///      is the Yul builtin for the program-counter opcode.
    function _rom(uint256 at) private view returns (uint256 word) {
        if (at >= ROM_WORDS) return 0;
        address src = ROM;
        assembly {
            let p := mload(0x40)
            mstore(p, 0)
            extcodecopy(src, add(p, 28), add(1, mul(at, 4)), 4)
            word := mload(p)
        }
    }

    function _ramRead(uint256 a) private view returns (uint256) {
        uint256 per = RAM_PER_WORD;
        return (_ram[a / per] >> ((a % per) * RAM_CELL_BITS)) & RAM_CELL_MASK;
    }

    function _ramWrite(uint256 a, uint256 v) private {
        uint256 per = RAM_PER_WORD;
        uint256 i = a / per;
        uint256 sh = (a % per) * RAM_CELL_BITS;
        uint256 mask = RAM_CELL_MASK;
        _ram[i] = (_ram[i] & ~(mask << sh)) | ((v & mask) << sh);
    }

    /// @dev Stores `data` as the body of a new contract and returns its
    ///      address. The deployed code is `00 || data`, so the leading STOP
    ///      makes the result impossible to call and reads start at offset 1.
    function _writeRom(bytes memory data) private returns (address ptr) {
        bytes memory creation = abi.encodePacked(
            hex"63",
            uint32(data.length + 1),
            hex"80600E6000396000F300",
            data
        );
        assembly {
            ptr := create(0, add(creation, 32), mload(creation))
        }
        if (ptr == address(0)) revert RomWriteFailed();
    }
}

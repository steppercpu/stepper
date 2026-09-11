// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Spec} from "./IGateArray.sol";

/// @notice The part of a chip this renderer needs: what silicon it runs on.
interface IChipSpec {
    function spec() external view returns (Spec memory);
}

/// @title  ChipRenderer
/// @notice Draws a chip's card on chain, from the chip's own address.
/// @dev    Nothing here fetches anything off chain. A card that points at a
///         server is a card that stops existing when somebody forgets to pay
///         for the server, and an NFT whose picture can disappear is a receipt
///         rather than an object.
///
///         The lattice is derived from the chip's address, so no two cards are
///         alike and the picture is a function of the thing it depicts rather
///         than a decoration chosen for it. There is no owner and no storage:
///         nobody can change what a card looks like after it is minted.
///
///         Every figure on the card is read from the chip's own `spec()` at
///         the moment it is asked for. An earlier version carried the ST-8
///         numbers as literals, which meant a chip of any other generation
///         would have minted a card describing a processor it is not. `Chip`
///         is generation-agnostic by design; this has to be as well, or the
///         design buys nothing.
contract ChipRenderer {
    string private constant WELL = "#04070a";
    string private constant GREEN = "#00e015";
    string private constant LIT = "#4dfa5c";
    string private constant COLD = "#12313c";
    string private constant INK = "#e7eef3";
    string private constant DIM = "#7d8d99";

    bytes private constant HEX = "0123456789abcdef";
    bytes private constant B64 =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    /// @notice The metadata document for one chip, as a data URI.
    /// @dev    `view` rather than `pure` because the figures come from the
    ///         chip. The interface the factory calls through already declared
    ///         `view`, so this costs the caller nothing.
    function render(uint256 id, address chip, address token, address creator, uint64 born)
        external view returns (string memory)
    {
        Spec memory s = IChipSpec(chip).spec();
        string memory num = _num(id);
        string memory gen = string.concat("ST-", _num(s.dataBits));

        string memory head = string.concat(
            '{"name":"STEPPER Chip #', num,
            '","description":"A real ', _num(s.dataBits),
            "-bit processor living inside a contract on Robinhood Chain. ",
            _num(s.gates), " NAND gates and ", _num(s.flops),
            " flip-flops, walked one clock edge at a time by whoever pays for the next one. ",
            'This card is drawn on chain from the chip\'s own address.",'
        );

        string memory json = string.concat(
            head,
            '"image":"data:image/svg+xml;base64,', _b64(bytes(_svg(num, chip, gen, s.gates))), '",',
            '"attributes":[',
            '{"trait_type":"Chip","value":"', _addr(chip), '"},',
            '{"trait_type":"Token","value":"', _addr(token), '"},',
            '{"trait_type":"Creator","value":"', _addr(creator), '"},',
            '{"trait_type":"Generation","value":"', gen, '"},',
            '{"trait_type":"NAND gates","value":', _num(s.gates), "},",
            '{"trait_type":"Flip-flops","value":', _num(s.flops), "},",
            '{"display_type":"date","trait_type":"Born","value":', _num(born), "}]}"
        );
        return string.concat("data:application/json;base64,", _b64(bytes(json)));
    }

    /// @dev The card. A die of gates, lit from the address, under a wordmark.
    function _svg(string memory num, address chip, string memory gen, uint16 gates)
        private pure returns (string memory)
    {
        string memory cells = _lattice(chip);
        return string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600" width="600" height="600">',
            '<rect width="600" height="600" fill="', WELL, '"/>',
            '<g opacity="0.5">', _grid(), "</g>",
            '<text x="44" y="72" fill="', INK,
            '" font-family="monospace" font-size="30" letter-spacing="7">STEPPER</text>',
            '<text x="44" y="102" fill="', DIM,
            '" font-family="monospace" font-size="15" letter-spacing="4">',
            gen, " &#183; ", _num(gates), " NAND</text>",
            '<g transform="translate(44,150)">', cells, "</g>",
            '<text x="44" y="512" fill="', GREEN,
            '" font-family="monospace" font-size="42">#', num, "</text>",
            '<text x="44" y="548" fill="', DIM,
            '" font-family="monospace" font-size="15">', _short(chip), "</text>",
            '<rect x="44" y="566" width="512" height="2" fill="', COLD, '"/>',
            "</svg>"
        );
    }

    /// @dev A faint rule every forty pixels, so the die sits on something.
    function _grid() private pure returns (string memory) {
        bytes memory buf = new bytes(14 * 140);
        uint256 at = 0;
        for (uint256 i = 1; i < 15; i++) {
            string memory p = _num(i * 40);
            at = _put(buf, at, '<rect x="');
            at = _put(buf, at, p);
            at = _put(buf, at, '" y="0" width="1" height="600" fill="');
            at = _put(buf, at, COLD);
            at = _put(buf, at, '"/>');
            at = _put(buf, at, '<rect x="0" y="');
            at = _put(buf, at, p);
            at = _put(buf, at, '" width="600" height="1" fill="');
            at = _put(buf, at, COLD);
            at = _put(buf, at, '"/>');
        }
        return _trim(buf, at);
    }

    /// @dev Sixteen by ten cells, lit from the twenty bytes of the address.
    ///      Most of a real die is dark at any instant: an eighth of the cells
    ///      run bright, a quarter run warm, and the rest are gates nothing is
    ///      asking about this cycle. Lighting more of it reads as noise.
    ///      Every card is different because every chip is at a different
    ///      address, and the same chip always draws the same card.
    function _lattice(address chip) private pure returns (string memory) {
        uint256 bits = uint256(uint160(chip));
        /* 72 bytes is the longest a cell can be: three digits of x, three of
           y, and a seven-character colour. Sized once, trimmed at the end. */
        bytes memory buf = new bytes(160 * 72);
        uint256 p = 0;
        for (uint256 r = 0; r < 10; r++) {
            for (uint256 c = 0; c < 16; c++) {
                uint256 i = r * 16 + c;
                uint256 v = (bits >> (i % 160)) & 7;
                string memory fill = v > 6 ? LIT : v > 4 ? GREEN : COLD;
                p = _put(buf, p, '<rect x="');
                p = _put(buf, p, _num(c * 32));
                p = _put(buf, p, '" y="');
                p = _put(buf, p, _num(r * 32));
                p = _put(buf, p, '" width="24" height="24" rx="3" fill="');
                p = _put(buf, p, fill);
                p = _put(buf, p, '"/>');
            }
        }
        return _trim(buf, p);
    }

    /* --------------------------------------------------------- appending */

    /* `out = string.concat(out, piece)` allocates a fresh copy of everything
       written so far, so building the lattice a cell at a time copied it 160
       times and the finished card cost 67,533,668 gas to produce. That is
       about twice an Ethereum block and well past what a node will let an
       `eth_call` spend, which meant every wallet, marketplace and explorer
       asking for the card got an error rather than a picture.
       Nothing about the card was wrong. Nobody could afford to look at it.
       These two write once instead. */
    function _put(bytes memory buf, uint256 p, string memory s)
        private pure returns (uint256)
    {
        bytes memory b = bytes(s);
        for (uint256 i = 0; i < b.length; i++) buf[p + i] = b[i];
        return p + b.length;
    }

    function _trim(bytes memory buf, uint256 n) private pure returns (string memory) {
        bytes memory out = new bytes(n);
        for (uint256 i = 0; i < n; i++) out[i] = buf[i];
        return string(out);
    }

    /* -------------------------------------------------------------- text */

    function _num(uint256 v) private pure returns (string memory) {
        if (v == 0) return "0";
        uint256 n = v;
        uint256 len;
        while (n != 0) { len++; n /= 10; }
        bytes memory s = new bytes(len);
        while (v != 0) { s[--len] = bytes1(uint8(48 + (v % 10))); v /= 10; }
        return string(s);
    }

    function _addr(address a) private pure returns (string memory) {
        bytes memory s = new bytes(42);
        s[0] = "0";
        s[1] = "x";
        uint160 v = uint160(a);
        for (uint256 i = 0; i < 20; i++) {
            uint8 b = uint8(v >> (8 * (19 - i)));
            s[2 + i * 2] = HEX[b >> 4];
            s[3 + i * 2] = HEX[b & 15];
        }
        return string(s);
    }

    /// @dev The form an address is read in: enough of both ends to check one
    ///      against what somebody sent you, which is the only thing a short
    ///      address is ever used for.
    function _short(address a) private pure returns (string memory) {
        bytes memory full = bytes(_addr(a));
        bytes memory s = new bytes(15);
        for (uint256 i = 0; i < 6; i++) s[i] = full[i];
        s[6] = ".";
        s[7] = ".";
        s[8] = ".";
        for (uint256 i = 0; i < 6; i++) s[9 + i] = full[36 + i];
        return string(s);
    }

    /// @dev Base64, because a data URI is the only way a picture written by a
    ///      contract reaches a wallet without a server in between.
    function _b64(bytes memory data) private pure returns (string memory) {
        if (data.length == 0) return "";
        /* One copy of the alphabet. Indexing the constant directly copies
           all 64 bytes out of code on every lookup, and there are tens of
           thousands of lookups in one card. */
        bytes memory abc = B64;
        uint256 len = 4 * ((data.length + 2) / 3);
        bytes memory out = new bytes(len);
        uint256 j = 0;
        uint256 i = 0;
        while (i + 3 <= data.length) {
            uint256 n = (uint256(uint8(data[i])) << 16) |
                (uint256(uint8(data[i + 1])) << 8) |
                uint256(uint8(data[i + 2]));
            out[j++] = abc[(n >> 18) & 63];
            out[j++] = abc[(n >> 12) & 63];
            out[j++] = abc[(n >> 6) & 63];
            out[j++] = abc[n & 63];
            i += 3;
        }
        uint256 rest = data.length - i;
        if (rest == 1) {
            uint256 n = uint256(uint8(data[i])) << 16;
            out[j++] = abc[(n >> 18) & 63];
            out[j++] = abc[(n >> 12) & 63];
            out[j++] = "=";
            out[j++] = "=";
        } else if (rest == 2) {
            uint256 n = (uint256(uint8(data[i])) << 16) | (uint256(uint8(data[i + 1])) << 8);
            out[j++] = abc[(n >> 18) & 63];
            out[j++] = abc[(n >> 12) & 63];
            out[j++] = abc[(n >> 6) & 63];
            out[j++] = "=";
        }
        return string(out);
    }
}

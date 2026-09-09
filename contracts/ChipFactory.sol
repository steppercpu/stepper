// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Chip} from "./Chip.sol";
import {IGateArray} from "./IGateArray.sol";

/// @notice The venue's social links, in the venue's own order. Getting this
///         order wrong would put every chip's Telegram in its website field,
///         so it mirrors their struct exactly and is passed straight through.
struct Socials {
    string twitter;
    string telegram;
    string discord;
    string website;
    string farcaster;
}

/// @notice Everything the venue needs to create a token.
/// @dev    `expectedEconomics` is read from the venue's own preview call and
///         pins the terms the creator was quoted, so a configuration change
///         between reading and sending cannot settle the launch on different
///         ones. `salt` makes the addresses predictable before sending.
struct TokenParams {
    string name;
    string symbol;
    string logo;
    string description;
    Socials socials;
    address creatorFeeRecipient;
    uint16 creatorTaxBps;
    bool buybackEnabled;
    bytes32 expectedEconomics;
    bytes32 salt;
}

/// @notice The venue's launch factory.
interface ILaunchVenue {
    function launchToken(TokenParams calldata params, uint256 launchConfigId, address pairToken)
        external payable returns (address token, address curve);
    function launchFee() external view returns (uint256);
    function canLaunch(address who) external view returns (bool);
}

/// @notice Enough of an ERC-20 to hand the creator what the launch bought.
interface IERC20Minimal {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @notice Draws the card for a chip. Kept separate so the factory can hold a
///         whole processor's creation code and still fit on chain.
interface IChipRenderer {
    function render(uint256 id, address chip, address token, address creator, uint64 born)
        external view returns (string memory);
}

interface IERC721Receiver {
    function onERC721Received(address operator, address from, uint256 id, bytes calldata data)
        external returns (bytes4);
}

/// @title  ChipFactory
/// @notice One transaction: a processor is deployed, a token is launched
///         against it, and the creator is handed the deed to both.
/// @dev    The affiliation is the reason this contract exists. A chip and its
///         token created in separate transactions are two objects somebody
///         asserts are related; created here they are written into each other
///         at birth, and the record cannot be edited afterwards because there
///         is no function that edits it.
///
///         There is no owner. Nothing here can be paused, upgraded, or
///         redirected, no address is privileged, and the factory keeps
///         nothing: every token the launch buys and every wei of change goes
///         to the creator in the same call.
contract ChipFactory {
    /// @notice The silicon every chip from this factory runs on.
    IGateArray public immutable ARRAY;

    /// @notice The venue that creates the tokens.
    ILaunchVenue public immutable VENUE;

    /// @notice Draws the card.
    IChipRenderer public immutable RENDERER;

    /// @notice What a chip is, once it exists.
    struct Record {
        address chip;
        address token;
        address curve;
        address creator;
        uint64 born;
    }

    /// @notice Every chip this factory has made, by id. Ids start at one.
    mapping(uint256 => Record) public records;

    /// @notice The id of a chip address, or zero if this factory did not make it.
    mapping(address => uint256) public idOfChip;

    /// @notice How many chips exist.
    uint256 public total;

    string public constant name = "STEPPER Chips";
    string public constant symbol = "CHIP";

    mapping(uint256 => address) private _owner;
    mapping(address => uint256) private _balance;
    mapping(uint256 => address) private _approved;
    mapping(address => mapping(address => bool)) private _operator;

    event Transfer(address indexed from, address indexed to, uint256 indexed id);
    event Approval(address indexed owner, address indexed approved, uint256 indexed id);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    /// @notice A processor and its token, born together.
    event Launched(
        uint256 indexed id,
        address indexed creator,
        address indexed chip,
        address token,
        address curve
    );

    error ZeroAddress();
    error EmptyRom();
    error FeeTooLow(uint256 sent, uint256 required);
    error NotAllowedToLaunch();
    error NoSuchChip();
    error NotOwnerNorApproved();
    error WrongOwner();
    error NotERC721Receiver();
    error RefundFailed();
    error Reentered();

    bytes32 private constant LOCK = keccak256("stepper.factory.lock");

    constructor(IGateArray array, ILaunchVenue venue, IChipRenderer renderer) {
        if (address(array) == address(0)) revert ZeroAddress();
        if (address(venue) == address(0)) revert ZeroAddress();
        if (address(renderer) == address(0)) revert ZeroAddress();
        ARRAY = array;
        VENUE = venue;
        RENDERER = renderer;
    }

    /// @notice Accepts the venue's change.
    /// @dev    Not decoration. The whole of `msg.value` is forwarded so the
    ///         opening buy can be made out of it, and the venue hands back
    ///         whatever the buy did not spend. Without this the refund reverts
    ///         and every launch that sends more than the fee fails, which is
    ///         every launch anybody would actually want to make.
    ///
    ///         Ether that arrives any other way leaves with the next launch.
    ///         This contract is built to hold nothing and there is no function
    ///         that lets anyone withdraw from it.
    receive() external payable {}

    /// @notice Deploy a chip, launch its token, and mint the deed.
    /// @param  rom the program, four bytes per instruction, big endian. It is
    ///         written into the chip at construction and can never change.
    /// @param  params the venue's token parameters, passed through unaltered
    ///         except for the fee recipient. See the note on that below.
    /// @param  launchConfigId which of the venue's configurations to launch on.
    /// @param  pairToken what the token trades against, or zero for native.
    /// @return id the chip's number, and the id of the NFT that owns it.
    /// @dev    Send at least `VENUE.launchFee()`. Anything above it is
    ///         forwarded to the venue as well, because that is how the
    ///         creator's opening buy is made: whatever it buys arrives here
    ///         and is passed straight to the creator before this call returns.
    ///
    ///         **The fee recipient is never left at zero.** The venue reads a
    ///         zero recipient as "the caller", and the caller here is this
    ///         contract, which would quietly make the factory the creator of
    ///         everybody's token. A zero is replaced with the sender.
    function launch(
        bytes calldata rom,
        TokenParams calldata params,
        uint256 launchConfigId,
        address pairToken
    ) external payable returns (uint256 id, address chip, address token, address curve) {
        _enter();

        if (rom.length == 0) revert EmptyRom();
        if (!VENUE.canLaunch(address(this))) revert NotAllowedToLaunch();

        uint256 fee = VENUE.launchFee();
        if (msg.value < fee) revert FeeTooLow(msg.value, fee);

        chip = address(new Chip(ARRAY, rom));

        TokenParams memory p = params;
        if (p.creatorFeeRecipient == address(0)) p.creatorFeeRecipient = msg.sender;

        (token, curve) = VENUE.launchToken{value: msg.value}(p, launchConfigId, pairToken);

        id = ++total;
        records[id] = Record({
            chip: chip,
            token: token,
            curve: curve,
            creator: msg.sender,
            born: uint64(block.timestamp)
        });
        idOfChip[chip] = id;

        _mint(msg.sender, id);
        emit Launched(id, msg.sender, chip, token, curve);

        _sweep(token);
        _exit();
    }

    /// @notice Hand the creator whatever the launch left behind.
    /// @dev    The opening buy is credited to whoever called the venue, which
    ///         is this contract. Holding it would be theft by architecture, so
    ///         both the tokens and any unspent value leave in the same call.
    ///         A factory that keeps a balance is a factory somebody has to be
    ///         trusted not to empty.
    function _sweep(address token) private {
        uint256 got = IERC20Minimal(token).balanceOf(address(this));
        if (got != 0) IERC20Minimal(token).transfer(msg.sender, got);

        uint256 left = address(this).balance;
        if (left != 0) {
            (bool ok, ) = msg.sender.call{value: left}("");
            if (!ok) revert RefundFailed();
        }
    }

    /// @notice The record for a chip address.
    function recordOfChip(address chip) external view returns (Record memory) {
        uint256 id = idOfChip[chip];
        if (id == 0) revert NoSuchChip();
        return records[id];
    }

    /* ------------------------------------------------------------ ERC-721 */

    function tokenURI(uint256 id) external view returns (string memory) {
        Record memory r = records[id];
        if (r.chip == address(0)) revert NoSuchChip();
        return RENDERER.render(id, r.chip, r.token, r.creator, r.born);
    }

    function supportsInterface(bytes4 iid) external pure returns (bool) {
        return iid == 0x01ffc9a7 || iid == 0x80ac58cd || iid == 0x5b5e139f;
    }

    function balanceOf(address who) external view returns (uint256) {
        if (who == address(0)) revert ZeroAddress();
        return _balance[who];
    }

    function ownerOf(uint256 id) public view returns (address) {
        address o = _owner[id];
        if (o == address(0)) revert NoSuchChip();
        return o;
    }

    function approve(address to, uint256 id) external {
        address o = ownerOf(id);
        if (msg.sender != o && !_operator[o][msg.sender]) revert NotOwnerNorApproved();
        _approved[id] = to;
        emit Approval(o, to, id);
    }

    function getApproved(uint256 id) external view returns (address) {
        ownerOf(id);
        return _approved[id];
    }

    function setApprovalForAll(address operator, bool ok) external {
        _operator[msg.sender][operator] = ok;
        emit ApprovalForAll(msg.sender, operator, ok);
    }

    function isApprovedForAll(address o, address operator) external view returns (bool) {
        return _operator[o][operator];
    }

    function transferFrom(address from, address to, uint256 id) public {
        if (to == address(0)) revert ZeroAddress();
        address o = ownerOf(id);
        if (o != from) revert WrongOwner();
        if (msg.sender != o && msg.sender != _approved[id] && !_operator[o][msg.sender]) {
            revert NotOwnerNorApproved();
        }
        delete _approved[id];
        unchecked {
            _balance[from] -= 1;
            _balance[to] += 1;
        }
        _owner[id] = to;
        emit Transfer(from, to, id);
    }

    function safeTransferFrom(address from, address to, uint256 id) external {
        safeTransferFrom(from, to, id, "");
    }

    function safeTransferFrom(address from, address to, uint256 id, bytes memory data) public {
        transferFrom(from, to, id);
        if (to.code.length != 0) {
            bytes4 got = IERC721Receiver(to).onERC721Received(msg.sender, from, id, data);
            if (got != IERC721Receiver.onERC721Received.selector) revert NotERC721Receiver();
        }
    }

    function _mint(address to, uint256 id) private {
        _owner[id] = to;
        unchecked { _balance[to] += 1; }
        emit Transfer(address(0), to, id);
    }

    /* ---------------------------------------------------------------- lock */

    function _enter() private {
        bytes32 slot = LOCK;
        bool held;
        assembly ("memory-safe") {
            held := tload(slot)
            tstore(slot, 1)
        }
        if (held) revert Reentered();
    }

    function _exit() private {
        bytes32 slot = LOCK;
        assembly ("memory-safe") {
            tstore(slot, 0)
        }
    }
}

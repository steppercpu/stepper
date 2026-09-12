// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {TokenParams} from "../ChipFactory.sol";
import {Spec} from "../IGateArray.sol";

/// @notice Test fixtures. Not part of the deployed set: `npm run compile`
///         reads contracts/*.sol and never looks in here, so nothing in this
///         file can reach a chain by accident.
///
/// @dev    The venue is mocked rather than forked because the behaviours that
///         matter are the awkward ones: crediting the opening buy to whoever
///         called, refunding change to whoever called, and reading a zero fee
///         recipient as "the caller". Those are exactly the behaviours that
///         would quietly make the factory the owner of everybody's launch, and
///         a fork test would reproduce them only by luck.

contract MockToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 v) external {
        balanceOf[to] += v;
    }

    function transfer(address to, uint256 v) external returns (bool) {
        balanceOf[msg.sender] -= v;
        balanceOf[to] += v;
        return true;
    }
}

contract MockVenue {
    uint256 public launchFee = 0.0005 ether;
    bool public allow = true;

    address public lastRecipient;
    uint16 public lastTax;
    uint256 public lastValue;
    string public lastName;
    string public lastTelegram;
    uint256 public lastConfigId;
    address public lastPair;

    /// @notice How much of the supply the opening buy hands back to the caller.
    uint256 public openingBuy = 39_000_000 ether;

    function setAllow(bool v) external { allow = v; }
    function setOpeningBuy(uint256 v) external { openingBuy = v; }

    function canLaunch(address) external view returns (bool) { return allow; }

    function launchToken(TokenParams calldata p, uint256 configId, address pairToken)
        external payable returns (address token, address curve)
    {
        require(msg.value >= launchFee, "fee");
        lastRecipient = p.creatorFeeRecipient;
        lastTax = p.creatorTaxBps;
        lastValue = msg.value;
        lastName = p.name;
        lastTelegram = p.socials.telegram;
        lastConfigId = configId;
        lastPair = pairToken;

        MockToken t = new MockToken();
        t.mint(msg.sender, openingBuy);

        uint256 change = msg.value - launchFee;
        if (change != 0) {
            (bool ok, ) = msg.sender.call{value: change}("");
            require(ok, "change");
        }
        return (address(t), address(uint160(0xC0FFEE)));
    }
}

/// @notice The venue's fee escrow, as far as the router is concerned: a
///         balance that is credited to somebody and only moves when they ask.
contract MockEscrow {
    mapping(address => uint256) public balanceOf;

    receive() external payable {}

    function credit(address who) external payable {
        balanceOf[who] += msg.value;
    }

    function claim() external {
        uint256 owed = balanceOf[msg.sender];
        balanceOf[msg.sender] = 0;
        (bool ok, ) = msg.sender.call{value: owed}("");
        require(ok, "claim");
    }
}

/// @notice Just enough of the launch factory for the hatch.
contract MockRecipientRegistry {
    address public lastToken;
    address public lastRecipient;
    address public lastCaller;

    function transferCreatorFeeRecipient(address token, address recipient) external {
        lastToken = token;
        lastRecipient = recipient;
        lastCaller = msg.sender;
    }
}

/// @notice A chip that costs gas to step, so a reimbursement has something to
///         reimburse. It also counts, so a test can prove the edge was taken.
contract MockChip {
    uint256 public cycle;
    uint256 public lastIn;
    address public lastSponsor;

    function step(uint256 inValue) external {
        lastIn = inValue;
        lastSponsor = msg.sender;
        cycle += 1;
        /* Burn a little, so the measured cost is not zero. */
        uint256 acc;
        for (uint256 i = 0; i < 40; i++) acc = uint256(keccak256(abi.encode(acc, i)));
        lastIn = inValue + (acc & 0);
    }

    /// @dev The shape CycleRebate reads the counter from. A chip has no
    ///      `cycle()` getter, so the rebate takes the first snapshot field.
    function snapshot()
        external
        view
        returns (uint256, uint256, uint256, bool, bool, bool)
    {
        return (cycle, 0, 0, false, false, false);
    }
}

/// @notice A `step()` that does nothing, for the price of the calldata.
/// @dev    The attack CycleRebate's registry check exists to stop: without it
///         anybody could point the rebate at one of these and take the reserve
///         apart without a chip being involved at all.
contract FreeStep {
    function step(uint256) external {}

    function snapshot()
        external
        pure
        returns (uint256, uint256, uint256, bool, bool, bool)
    {
        return (1, 0, 0, false, false, false);
    }
}

/// @notice A token that calls back into its spender while transferring.
/// @dev    The attack a reentrancy guard exists for. Without one, a token like
///         this re-enters before the reserve balance has moved, sees the old
///         balance, and is paid twice for one clock edge.
contract ReentrantToken {
    mapping(address => uint256) public balanceOf;
    address public target;
    bool private inside;

    function mint(address to, uint256 v) external { balanceOf[to] += v; }
    function point(address t) external { target = t; }

    function transfer(address to, uint256 v) external returns (bool) {
        balanceOf[msg.sender] -= v;
        balanceOf[to] += v;
        if (target != address(0) && !inside) {
            inside = true;
            /* Ignore the outcome: the point is whether it succeeds, and the
               test reads that from the balances rather than from here. */
            (bool ok, ) = target.call(abi.encodeWithSignature("fuel(uint256)", uint256(1)));
            ok;
            inside = false;
        }
        return true;
    }
}

/// @notice A token that keeps a share of every transfer.
/// @dev    So the rebate's counters can be checked against what moved rather
///         than against what was asked for.
contract FeeToken {
    mapping(address => uint256) public balanceOf;
    uint256 public constant BPS = 200;

    function mint(address to, uint256 v) external { balanceOf[to] += v; }

    function transfer(address to, uint256 v) external returns (bool) {
        uint256 fee = (v * BPS) / 10000;
        balanceOf[msg.sender] -= v;
        balanceOf[to] += v - fee;
        return true;
    }
}

/// @notice A token whose transfer returns nothing at all.
/// @dev    Common enough to matter. A contract that insists on a bool would
///         revert against it for ever.
contract SilentToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 v) external { balanceOf[to] += v; }

    function transfer(address to, uint256 v) external {
        balanceOf[msg.sender] -= v;
        balanceOf[to] += v;
    }
}

/// @notice A registry that answers for whatever it has been told about.
contract MockChipRegistry {
    mapping(address => uint256) public idOfChip;
    uint256 private next;

    function add(address chip) external returns (uint256 id) {
        id = ++next;
        idOfChip[chip] = id;
    }
}

/// @notice A chip that reports whatever specification it is told to.
/// @dev    The renderer reads its figures from the chip. This fixture is how
///         a card can be checked against a generation that is not ST-8 without
///         deploying a whole second gate array for it, and it is the only way
///         to fail the renderer if it ever goes back to carrying the numbers
///         as literals — the ST-8 card looks identical either way.
contract MockSpecChip {
    Spec private _spec;

    constructor(uint16 gates, uint16 flops, uint8 dataBits) {
        _spec.gates = gates;
        _spec.flops = flops;
        _spec.dataBits = dataBits;
    }

    function spec() external view returns (Spec memory) {
        return _spec;
    }
}

/// @notice A recipient that refuses ether, for the payout-failure path.
contract Rejector {
    function ping() external pure returns (bool) { return true; }
}

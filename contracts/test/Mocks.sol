// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {TokenParams} from "../ChipFactory.sol";

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

    function step(uint256 inValue) external {
        lastIn = inValue;
        cycle += 1;
        /* Burn a little, so the measured cost is not zero. */
        uint256 acc;
        for (uint256 i = 0; i < 40; i++) acc = uint256(keccak256(abi.encode(acc, i)));
        lastIn = inValue + (acc & 0);
    }
}

/// @notice A recipient that refuses ether, for the payout-failure path.
contract Rejector {
    function ping() external pure returns (bool) { return true; }
}

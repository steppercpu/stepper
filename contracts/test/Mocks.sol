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

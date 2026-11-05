// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {VerbatimVault} from "../src/VerbatimVault.sol";

contract LeakyVault is VerbatimVault {
    constructor(address everydayKey_, address rulesKey_, address[] memory watchedTokens_)
        VerbatimVault(everydayKey_, rulesKey_, watchedTokens_, new address[](0))
    {
        trustedContracts.push(address(this));
    }

    function setEverydayKey(address newKey) external {
        everydayKey = newKey;
    }

    function addContact(address contact) external {
        contacts.push(contact);
    }

    function setLimit(uint256 index, uint256 amount) external {
        dailyLimits[index] = amount;
    }

    function giveAllowance(address contact, Allowance calldata allowance) external {
        allowances[contact] = allowance;
    }

    function setValidity(uint256 duration) external {
        allowanceValidity = duration;
    }

    function backdateContact(address contact, uint256 time) external {
        savedAt[contact] = time;
    }

    function raiseNewContactLimit(uint256 index, uint256 amount) external {
        newContactLimits[index] = amount;
    }

    function shortenNewContactPeriod(uint256 duration) external {
        newContactPeriod = duration;
    }

    function shortenAllowanceMinAge(uint256 duration) external {
        allowanceMinAge = duration;
    }

    function shortenLooseningWait(uint256 duration) external {
        looseningWait = duration;
    }

    function reopenSetup() external {
        setupFinished = false;
    }

    function raiseTolerance(uint256 basisPoints) external {
        tradeTolerance = basisPoints;
    }

    function swapPriceSource(address source) external {
        priceSource = source;
    }
}

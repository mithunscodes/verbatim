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
}

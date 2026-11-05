// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract TestDirectory {
    address[] private addresses;

    constructor(address[] memory addresses_) {
        addresses = addresses_;
    }

    function add(address account) external {
        addresses.push(account);
    }

    function listed() external view returns (address[] memory) {
        return addresses;
    }

    function isListed(address account) external view returns (bool) {
        for (uint256 i = 0; i < addresses.length; i++) {
            if (addresses[i] == account) return true;
        }
        return false;
    }
}

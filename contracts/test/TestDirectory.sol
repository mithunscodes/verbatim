// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract TestDirectory {
    address[] private addresses;
    mapping(string => address) private names;

    constructor(address[] memory addresses_) {
        addresses = addresses_;
    }

    function add(address account) external {
        addresses.push(account);
    }

    function setName(string calldata name, address account) external {
        names[name] = account;
    }

    function addressOf(string calldata name) external view returns (address) {
        return names[name];
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

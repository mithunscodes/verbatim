// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract TestDirectory {
    address[] private addresses;
    mapping(string => address) private names;
    mapping(string => address) private resolvers;
    bool public broken;
    bytes[] private calls;

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

    function setResolver(string calldata name, address resolver) external {
        resolvers[name] = resolver;
    }

    function setBroken(bool broken_) external {
        broken = broken_;
    }

    function addRecord(bytes calldata call) external {
        calls.push(call);
    }

    function resolverOf(string calldata name) external view returns (address) {
        return resolvers[name];
    }

    function records(address, uint256, uint256) external view returns (bytes[] memory) {
        require(!broken, "Directory broken");
        return calls;
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

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract ReplayDirectory {
    address[] private trusted;

    constructor(address[] memory trusted_) {
        trusted = trusted_;
    }

    function listed() external view returns (address[] memory) {
        return trusted;
    }

    function isListed(address account) external view returns (bool) {
        for (uint256 i = 0; i < trusted.length; i++) {
            if (trusted[i] == account) return true;
        }
        return false;
    }

    function addressOf(string calldata) external pure returns (address) {
        return address(0);
    }

    function resolverOf(string calldata) external pure returns (address) {
        return address(0);
    }

    function records(address, uint256, uint256) external pure returns (bytes[] memory) {
        return new bytes[](0);
    }
}

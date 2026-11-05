// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {VerbatimVault} from "./VerbatimVault.sol";

contract VaultFactory {
    address[] public watchedTokens;
    address public directory;
    address[] public vaults;
    mapping(address => address) public vaultOf;
    mapping(address => address[]) private guardedBy;

    event VaultCreated(address indexed vault, address indexed everydayKey, address indexed rulesKey);

    constructor(address[] memory watchedTokens_, address directory_) {
        watchedTokens = watchedTokens_;
        directory = directory_;
    }

    function createVault(address rulesKey) external returns (address vault) {
        require(vaultOf[msg.sender] == address(0), "You already have a vault");
        vault = address(new VerbatimVault(msg.sender, rulesKey, watchedTokens, directory));
        vaultOf[msg.sender] = vault;
        guardedBy[rulesKey].push(vault);
        vaults.push(vault);
        emit VaultCreated(vault, msg.sender, rulesKey);
    }

    function vaultsGuardedBy(address rulesKey) external view returns (address[] memory) {
        return guardedBy[rulesKey];
    }

    function vaultCount() external view returns (uint256) {
        return vaults.length;
    }
}

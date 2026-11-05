// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {VerbatimVault} from "./VerbatimVault.sol";

contract VaultFactory {
    address[] public watchedTokens;
    address public directory;
    address public immutable vaultCode;
    mapping(address => address) public vaultOf;
    mapping(address => address[]) private guardedBy;

    event VaultCreated(address indexed vault, address indexed everydayKey, address indexed rulesKey);

    constructor(address[] memory watchedTokens_, address directory_) {
        watchedTokens = watchedTokens_;
        directory = directory_;
        bytes memory code = abi.encodePacked(hex"00", type(VerbatimVault).creationCode);
        bytes memory init = abi.encodePacked(hex"61", uint16(code.length), hex"80600a3d393df3", code);
        address stored;
        assembly {
            stored := create(0, add(init, 32), mload(init))
        }
        require(stored != address(0), "Couldn't store the vault code");
        vaultCode = stored;
    }

    function createVault(address rulesKey) external returns (address vault) {
        require(vaultOf[msg.sender] == address(0), "You already have a vault");
        address store = vaultCode;
        bytes memory init = new bytes(store.code.length - 1);
        assembly {
            extcodecopy(store, add(init, 32), 1, mload(init))
        }
        init = abi.encodePacked(init, abi.encode(msg.sender, rulesKey, watchedTokens, directory));
        assembly {
            vault := create(0, add(init, 32), mload(init))
            if iszero(vault) {
                returndatacopy(0, 0, returndatasize())
                revert(0, returndatasize())
            }
        }
        vaultOf[msg.sender] = vault;
        guardedBy[rulesKey].push(vault);
        emit VaultCreated(vault, msg.sender, rulesKey);
    }

    function vaultsGuardedBy(address rulesKey) external view returns (address[] memory) {
        return guardedBy[rulesKey];
    }
}

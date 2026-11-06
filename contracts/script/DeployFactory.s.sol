// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {EnsDirectory} from "../src/EnsDirectory.sol";
import {EnsSettings} from "./EnsSettings.sol";
import {VaultFactory} from "../src/VaultFactory.sol";

contract DeployFactory is Script {
    address constant BUILDER_KEY = 0x81f65B53Cbe72AbCa6a6BDe4bE79d838770D9FC0;
    address constant USDC = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238;

    function run() external returns (VaultFactory factory) {
        uint256 builderPrivateKey = vm.envUint("BUILDER_PRIVATE_KEY");
        require(vm.addr(builderPrivateKey) == BUILDER_KEY, "BUILDER_PRIVATE_KEY is not the Builder key");
        address[] memory watchedTokens = new address[](1);
        watchedTokens[0] = USDC;
        vm.startBroadcast(builderPrivateKey);
        EnsDirectory directory = EnsSettings.deployDirectory();
        factory = new VaultFactory(watchedTokens, address(directory));
        vm.stopBroadcast();
        console.log("Directory:", address(directory));
        console.log("Factory:", address(factory));
    }
}

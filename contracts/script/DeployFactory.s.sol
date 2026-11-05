// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {VaultFactory} from "../src/VaultFactory.sol";

contract DeployFactory is Script {
    address constant BUILDER_KEY = 0xc0bF91f3BD0d479D5104d975B08885A73b032ce2;
    address constant USDC = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238;
    address constant UNIVERSAL_ROUTER = 0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b;

    function run() external returns (VaultFactory factory) {
        uint256 builderPrivateKey = vm.envUint("BUILDER_PRIVATE_KEY");
        require(vm.addr(builderPrivateKey) == BUILDER_KEY, "BUILDER_PRIVATE_KEY is not the Builder key");
        address[] memory watchedTokens = new address[](1);
        watchedTokens[0] = USDC;
        address[] memory trustedContracts = new address[](1);
        trustedContracts[0] = UNIVERSAL_ROUTER;
        vm.startBroadcast(builderPrivateKey);
        factory = new VaultFactory(watchedTokens, trustedContracts);
        vm.stopBroadcast();
        console.log("Factory:", address(factory));
    }
}

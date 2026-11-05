// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {VerbatimVault} from "../src/VerbatimVault.sol";

contract DeployVault is Script {
    address constant BUILDER_KEY = 0xc0bF91f3BD0d479D5104d975B08885A73b032ce2;
    address constant EVERYDAY_KEY = 0xe20366e072D4240031033DD271588f2bCb5D57BF;
    address constant RULES_KEY = 0x68eAf7d0f23d6dE4208b642CEf3d88a7d12cE90E;
    address constant USDC = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238;
    address constant UNIVERSAL_ROUTER = 0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b;

    function run() external returns (VerbatimVault vault) {
        uint256 builderPrivateKey = vm.envUint("BUILDER_PRIVATE_KEY");
        require(vm.addr(builderPrivateKey) == BUILDER_KEY, "BUILDER_PRIVATE_KEY is not the Builder key");
        address[] memory watchedTokens = new address[](1);
        watchedTokens[0] = USDC;
        address[] memory trustedContracts = new address[](1);
        trustedContracts[0] = UNIVERSAL_ROUTER;
        vm.startBroadcast(builderPrivateKey);
        vault = new VerbatimVault(EVERYDAY_KEY, RULES_KEY, watchedTokens, trustedContracts);
        vm.stopBroadcast();
        console.log("Vault:", address(vault));
    }
}

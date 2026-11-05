// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {VerbatimVault, IERC20} from "../src/VerbatimVault.sol";

contract FirstTransfer is Script {
    address constant EVERYDAY_KEY = 0xe20366e072D4240031033DD271588f2bCb5D57BF;
    address constant USDC = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238;
    uint256 constant AMOUNT = 1e6;

    function run(address payable vaultAddress) external {
        uint256 everydayPrivateKey = vm.envUint("EVERYDAY_PRIVATE_KEY");
        require(vm.addr(everydayPrivateKey) == EVERYDAY_KEY, "EVERYDAY_PRIVATE_KEY is not the Everyday key");
        VerbatimVault vault = VerbatimVault(vaultAddress);
        VerbatimVault.Action[] memory actions = new VerbatimVault.Action[](1);
        actions[0] = VerbatimVault.Action(USDC, 0, abi.encodeCall(IERC20.transfer, (EVERYDAY_KEY, AMOUNT)), 0);
        VerbatimVault.Check[] memory checks = new VerbatimVault.Check[](2);
        checks[0] = VerbatimVault.Check(VerbatimVault.CheckKind.AtMostLeaves, USDC, address(0), AMOUNT);
        checks[1] = VerbatimVault.Check(VerbatimVault.CheckKind.ExactlyTo, USDC, EVERYDAY_KEY, AMOUNT);
        console.log("Vault USDC before:", IERC20(USDC).balanceOf(vaultAddress));
        vm.startBroadcast(everydayPrivateKey);
        vault.run(actions, checks, block.timestamp + 10 minutes);
        vm.stopBroadcast();
        console.log("Vault USDC after:", IERC20(USDC).balanceOf(vaultAddress));
    }
}

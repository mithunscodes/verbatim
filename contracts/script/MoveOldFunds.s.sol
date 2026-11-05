// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {VerbatimVault, IERC20} from "../src/VerbatimVault.sol";

contract MoveOldFunds is Script {
    address constant EVERYDAY_KEY = 0xe20366e072D4240031033DD271588f2bCb5D57BF;
    address constant USDC = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238;
    address payable constant OLD_VAULT = payable(0x81F3487BFc789f8C2197485d2Fc80d3B34e73b56);
    address constant NEW_VAULT = 0xd03a1550f19E6b815a80a51ae40b8807c4702A69;

    function run() external {
        uint256 everydayPrivateKey = vm.envUint("EVERYDAY_PRIVATE_KEY");
        require(vm.addr(everydayPrivateKey) == EVERYDAY_KEY, "EVERYDAY_PRIVATE_KEY is not the Everyday key");
        uint256 amount = IERC20(USDC).balanceOf(OLD_VAULT);
        require(amount > 0, "The old vault is empty");
        VerbatimVault.Action[] memory actions = new VerbatimVault.Action[](1);
        actions[0] = VerbatimVault.Action(USDC, 0, abi.encodeCall(IERC20.transfer, (NEW_VAULT, amount)), 0);
        VerbatimVault.Check[] memory checks = new VerbatimVault.Check[](2);
        checks[0] = VerbatimVault.Check(VerbatimVault.CheckKind.AtMostLeaves, USDC, address(0), amount);
        checks[1] = VerbatimVault.Check(VerbatimVault.CheckKind.ExactlyTo, USDC, NEW_VAULT, amount);
        console.log("Moving test USDC, 6 decimals:", amount);
        vm.startBroadcast(everydayPrivateKey);
        VerbatimVault(OLD_VAULT).run(actions, checks, block.timestamp + 10 minutes);
        vm.stopBroadcast();
        console.log("Old vault USDC after:", IERC20(USDC).balanceOf(OLD_VAULT));
        console.log("New vault USDC after:", IERC20(USDC).balanceOf(NEW_VAULT));
    }
}

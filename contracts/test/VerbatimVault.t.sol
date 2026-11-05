// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {VerbatimVault} from "../src/VerbatimVault.sol";
import {TestToken} from "./TestToken.sol";

contract VerbatimVaultTest is Test {
    VerbatimVault vault;
    TestToken usdc;
    address everydayKey = makeAddr("everydayKey");
    address rulesKey = makeAddr("rulesKey");
    address stranger = makeAddr("stranger");
    address mom = makeAddr("mom");

    event Ran(bytes32 indexed actionsHash, bytes32 indexed checksHash, uint256 actionCount, uint256 deadline);

    function setUp() public {
        usdc = new TestToken();
        vault = new VerbatimVault(everydayKey, rulesKey, watched(), noContracts());
        usdc.mint(address(vault), 100e6);
        vm.deal(address(vault), 1 ether);
        vm.startPrank(rulesKey);
        vault.saveContact(mom);
        vault.setDailyLimit(address(usdc), 100e6);
        vault.setDailyLimit(address(0), 1 ether);
        vm.stopPrank();
        vm.warp(block.timestamp + 1 days);
    }

    function sendUsdc(address to, uint256 amount) internal view returns (VerbatimVault.Action[] memory actions) {
        actions = new VerbatimVault.Action[](1);
        actions[0] = VerbatimVault.Action(address(usdc), 0, abi.encodeCall(TestToken.transfer, (to, amount)), 0);
    }

    function noChecks() internal pure returns (VerbatimVault.Check[] memory) {
        return new VerbatimVault.Check[](0);
    }

    function limit(address token, uint256 amount) internal pure returns (VerbatimVault.Check[] memory checks) {
        checks = new VerbatimVault.Check[](1);
        checks[0] = VerbatimVault.Check(VerbatimVault.CheckKind.AtMostLeaves, token, address(0), amount);
    }

    function watched() internal view returns (address[] memory tokens) {
        tokens = new address[](1);
        tokens[0] = address(usdc);
    }

    function noContracts() internal pure returns (address[] memory) {
        return new address[](0);
    }

    function test_KnowsItsKeys() public view {
        assertEq(vault.everydayKey(), everydayKey);
        assertEq(vault.rulesKey(), rulesKey);
    }

    function test_RevertWhen_KeysEmptyOrSame() public {
        vm.expectRevert("Keys can't be empty");
        new VerbatimVault(address(0), rulesKey, watched(), noContracts());
        vm.expectRevert("The two keys must be different");
        new VerbatimVault(everydayKey, everydayKey, watched(), noContracts());
    }

    function test_DepositEth() public {
        vm.deal(stranger, 2 ether);
        vm.prank(stranger);
        (bool ok,) = address(vault).call{value: 2 ether}("");
        assertTrue(ok);
        assertEq(address(vault).balance, 3 ether);
    }

    function test_DepositToken() public {
        usdc.mint(stranger, 50e6);
        vm.prank(stranger);
        usdc.transfer(address(vault), 50e6);
        assertEq(usdc.balanceOf(address(vault)), 150e6);
    }

    function test_RunSendsToken() public {
        VerbatimVault.Action[] memory actions = sendUsdc(mom, 2e6);
        uint256 deadline = block.timestamp + 5 minutes;
        vm.expectEmit(address(vault));
        emit Ran(keccak256(abi.encode(actions)), keccak256(abi.encode(limit(address(usdc), 2e6))), 1, deadline);
        vm.prank(everydayKey);
        vault.run(actions, limit(address(usdc), 2e6), deadline);
        assertEq(usdc.balanceOf(mom), 2e6);
        assertEq(usdc.balanceOf(address(vault)), 98e6);
    }

    function test_RunSendsEth() public {
        VerbatimVault.Action[] memory actions = new VerbatimVault.Action[](1);
        actions[0] = VerbatimVault.Action(mom, 0.1 ether, "", 0);
        vm.prank(everydayKey);
        vault.run(actions, limit(address(0), 0.1 ether), block.timestamp);
        assertEq(mom.balance, 0.1 ether);
        assertEq(address(vault).balance, 0.9 ether);
    }

    function test_RevertWhen_NotEverydayKey() public {
        VerbatimVault.Action[] memory actions = sendUsdc(stranger, 100e6);
        uint256 deadline = block.timestamp + 5 minutes;
        vm.prank(stranger);
        vm.expectRevert("Only the everyday key can run");
        vault.run(actions, noChecks(), deadline);
        vm.prank(rulesKey);
        vm.expectRevert("Only the everyday key can run");
        vault.run(actions, noChecks(), deadline);
        assertEq(usdc.balanceOf(address(vault)), 100e6);
    }

    function test_RevertWhen_DeadlinePassed() public {
        VerbatimVault.Action[] memory actions = sendUsdc(mom, 2e6);
        uint256 deadline = block.timestamp + 5 minutes;
        vm.warp(deadline + 1);
        vm.prank(everydayKey);
        vm.expectRevert("Deadline passed");
        vault.run(actions, noChecks(), deadline);
        assertEq(usdc.balanceOf(mom), 0);
    }

    function test_RevertWhen_AnyActionFails() public {
        VerbatimVault.Action[] memory actions = new VerbatimVault.Action[](2);
        actions[0] = sendUsdc(mom, 2e6)[0];
        actions[1] = sendUsdc(mom, 500e6)[0];
        uint256 deadline = block.timestamp + 5 minutes;
        vm.prank(everydayKey);
        vm.expectRevert("An action failed");
        vault.run(actions, noChecks(), deadline);
        assertEq(usdc.balanceOf(mom), 0);
    }
}

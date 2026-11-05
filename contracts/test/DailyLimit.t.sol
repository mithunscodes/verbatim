// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {VerbatimVault, IPermit2} from "../src/VerbatimVault.sol";
import {TestToken} from "./TestToken.sol";
import {TestRouter} from "./TestRouter.sol";
import {LeakyVault} from "./LeakyVault.sol";

contract DailyLimitTest is Test {
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant ETH = address(0);

    VerbatimVault vault;
    TestToken usdc;
    TestRouter router;
    address everydayKey = makeAddr("everydayKey");
    address rulesKey = makeAddr("rulesKey");
    address mom = makeAddr("mom");
    address dad = makeAddr("dad");

    event DailyLimitSet(address indexed token, uint256 amount);

    function setUp() public {
        vm.etch(PERMIT2, vm.parseJsonBytes(vm.readFile("test/fixtures/permit2-sepolia.json"), ".code"));
        usdc = new TestToken();
        router = new TestRouter();
        vault = new VerbatimVault(everydayKey, rulesKey, list(address(usdc)), list(address(router)));
        usdc.mint(address(vault), 100e6);
        vm.deal(address(vault), 1 ether);
        vm.deal(address(router), 10 ether);
        vm.startPrank(rulesKey);
        vault.saveContact(mom);
        vault.saveContact(dad);
        vault.setDailyLimit(address(usdc), 10e6);
        vault.setDailyLimit(ETH, 0.1 ether);
        vault.finishSetup();
        vm.stopPrank();
        vm.warp(block.timestamp + 1 days);
    }

    function list(address item) internal pure returns (address[] memory items) {
        items = new address[](1);
        items[0] = item;
    }

    function sendUsdc(address to, uint256 amount) internal view returns (VerbatimVault.Action memory) {
        return VerbatimVault.Action(address(usdc), 0, abi.encodeCall(TestToken.transfer, (to, amount)), 0);
    }

    function only(VerbatimVault.Action memory action) internal pure returns (VerbatimVault.Action[] memory actions) {
        actions = new VerbatimVault.Action[](1);
        actions[0] = action;
    }

    function atMost(address token, uint256 amount) internal pure returns (VerbatimVault.Check[] memory checks) {
        checks = new VerbatimVault.Check[](1);
        checks[0] = VerbatimVault.Check(VerbatimVault.CheckKind.AtMostLeaves, token, address(0), amount);
    }

    function swapActions(uint256 amount) internal view returns (VerbatimVault.Action[] memory actions) {
        actions = new VerbatimVault.Action[](3);
        actions[0] = VerbatimVault.Action(address(usdc), 0, abi.encodeCall(TestToken.approve, (PERMIT2, amount)), 0);
        actions[1] = VerbatimVault.Action(
            PERMIT2,
            0,
            abi.encodeCall(IPermit2.approve, (address(usdc), address(router), uint160(amount), uint48(block.timestamp))),
            0
        );
        actions[2] = VerbatimVault.Action(
            address(router), 0, abi.encodeCall(TestRouter.swap, (address(usdc), uint160(amount), 0.0001 ether)), 0
        );
    }

    function pay(address to, uint256 amount) internal {
        vm.prank(everydayKey);
        vault.run(only(sendUsdc(to, amount)), atMost(address(usdc), amount), block.timestamp);
    }

    function payEth(address to, uint256 amount) internal {
        vm.prank(everydayKey);
        vault.run(only(VerbatimVault.Action(to, amount, "", 0)), atMost(ETH, amount), block.timestamp);
    }

    function swap(uint256 amount) internal {
        vm.prank(everydayKey);
        vault.run(swapActions(amount), atMost(address(usdc), amount), block.timestamp);
    }

    function test_LimitHoldsAcrossSeveralSends() public {
        pay(mom, 4e6);
        pay(dad, 4e6);
        assertEq(vault.leftToday(address(usdc)), 2e6);
        vm.expectRevert("Over the daily limit");
        pay(mom, 3e6);
        pay(mom, 2e6);
        assertEq(vault.leftToday(address(usdc)), 0);
        vm.expectRevert("Over the daily limit");
        pay(dad, 1);
        assertEq(usdc.balanceOf(mom), 6e6);
        assertEq(usdc.balanceOf(dad), 4e6);
        assertEq(usdc.balanceOf(address(vault)), 90e6);
    }

    function test_SendsInOneRunCountTogether() public {
        VerbatimVault.Action[] memory actions = new VerbatimVault.Action[](2);
        actions[0] = sendUsdc(mom, 6e6);
        actions[1] = sendUsdc(dad, 6e6);
        vm.prank(everydayKey);
        vm.expectRevert("Over the daily limit");
        vault.run(actions, atMost(address(usdc), 12e6), block.timestamp);
        assertEq(vault.leftToday(address(usdc)), 10e6);
        assertEq(usdc.balanceOf(address(vault)), 100e6);
    }

    function test_LimitResetsTheNextDay() public {
        uint256 firstSend = block.timestamp;
        pay(mom, 10e6);
        vm.warp(firstSend + 1 days - 1);
        assertEq(vault.leftToday(address(usdc)), 0);
        vm.expectRevert("Over the daily limit");
        pay(mom, 1);
        vm.warp(firstSend + 1 days);
        assertEq(vault.leftToday(address(usdc)), 10e6);
        pay(mom, 10e6);
        assertEq(usdc.balanceOf(mom), 20e6);
    }

    function test_TheDayStartsAtTheFirstSend() public {
        uint256 start = block.timestamp;
        pay(mom, 10e6);
        vm.warp(start + 30 hours);
        pay(mom, 4e6);
        vm.warp(start + 30 hours + 23 hours);
        assertEq(vault.leftToday(address(usdc)), 6e6);
        vm.expectRevert("Over the daily limit");
        pay(mom, 7e6);
        vm.warp(start + 30 hours + 24 hours);
        pay(mom, 10e6);
        assertEq(usdc.balanceOf(mom), 24e6);
    }

    function test_SwapsCountToo() public {
        swap(5e6);
        assertEq(vault.leftToday(address(usdc)), 5e6);
        vm.expectRevert("Over the daily limit");
        swap(6e6);
        swap(5e6);
        assertEq(vault.leftToday(address(usdc)), 0);
        assertEq(vault.leftToday(ETH), 0.1 ether);
        assertEq(address(vault).balance, 1.0002 ether);
    }

    function test_EthHasItsOwnLimit() public {
        payEth(mom, 0.06 ether);
        vm.expectRevert("Over the daily limit");
        payEth(mom, 0.05 ether);
        assertEq(vault.leftToday(ETH), 0.04 ether);
        assertEq(vault.leftToday(address(usdc)), 10e6);
        assertEq(mom.balance, 0.06 ether);
    }

    function test_NoLimitSetMeansNothingCanLeave() public {
        vault = new VerbatimVault(everydayKey, rulesKey, list(address(usdc)), list(address(router)));
        usdc.mint(address(vault), 100e6);
        vm.deal(address(vault), 1 ether);
        vm.startPrank(rulesKey);
        vault.saveContact(mom);
        vault.finishSetup();
        vm.stopPrank();
        assertEq(vault.dailyLimit(address(usdc)), 0);
        vm.expectRevert("Over the daily limit");
        pay(mom, 1);
        vm.expectRevert("Over the daily limit");
        payEth(mom, 1);
        assertEq(usdc.balanceOf(address(vault)), 100e6);
        assertEq(address(vault).balance, 1 ether);
    }

    function test_OnlyTheRulesKeyCanSetLimits() public {
        TestToken unwatched = new TestToken();
        vm.prank(everydayKey);
        vm.expectRevert("Only the rules key can set limits");
        vault.setDailyLimit(address(usdc), 1000e6);
        vm.prank(rulesKey);
        vm.expectRevert("Not a watched token");
        vault.setDailyLimit(address(unwatched), 0);
        vm.expectEmit(address(vault));
        emit DailyLimitSet(address(usdc), 5e6);
        vm.prank(rulesKey);
        vault.setDailyLimit(address(usdc), 5e6);
        assertEq(vault.dailyLimit(address(usdc)), 5e6);
        assertEq(vault.leftToday(address(usdc)), 5e6);
    }

    function test_LoweringTheLimitAfterSpendingLeavesNothingToday() public {
        pay(mom, 8e6);
        vm.prank(rulesKey);
        vault.setDailyLimit(address(usdc), 5e6);
        assertEq(vault.leftToday(address(usdc)), 0);
        vm.expectRevert("Over the daily limit");
        pay(mom, 1);
    }

    function test_LimitsCantChangeDuringARun() public {
        LeakyVault leaky = new LeakyVault(everydayKey, rulesKey, list(address(usdc)));
        vm.prank(rulesKey);
        leaky.finishSetup();
        VerbatimVault.Action memory sneaky =
            VerbatimVault.Action(address(leaky), 0, abi.encodeCall(LeakyVault.setLimit, (1, 1000e6)), 0);
        vm.prank(everydayKey);
        vm.expectRevert("Your account would change");
        leaky.run(only(sneaky), new VerbatimVault.Check[](0), block.timestamp);
        assertEq(leaky.dailyLimit(address(usdc)), 0);
    }
}

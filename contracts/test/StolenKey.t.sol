// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {VerbatimVault, IPermit2} from "../src/VerbatimVault.sol";
import {TestDirectory} from "./TestDirectory.sol";
import {TestToken} from "./TestToken.sol";
import {TestRouter} from "./TestRouter.sol";
import {TestPriceSource} from "./TestPriceSource.sol";

contract StolenKeyTest is Test {
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant ETH = address(0);
    uint256 constant ALL_USDC = 10_000e6;

    VerbatimVault vault;
    TestToken usdc;
    TestRouter router;
    TestPriceSource prices;
    address everydayKey = makeAddr("everydayKey");
    address rulesKey = makeAddr("rulesKey");
    address mom = makeAddr("mom");
    address attacker = makeAddr("attacker");

    function setUp() public {
        vm.etch(PERMIT2, vm.parseJsonBytes(vm.readFile("test/fixtures/permit2-sepolia.json"), ".code"));
        usdc = new TestToken();
        router = new TestRouter();
        prices = new TestPriceSource();
        prices.setPrice(address(usdc), 1e6, 1e6);
        prices.setPrice(ETH, 1 ether, 50_000e6);
        vault = new VerbatimVault(everydayKey, rulesKey, list(address(usdc)), address(new TestDirectory(list(address(router)))));
        usdc.mint(address(vault), ALL_USDC);
        vm.deal(address(vault), 1 ether);
        vm.deal(address(router), 10 ether);
        vm.startPrank(rulesKey);
        vault.saveContact(mom);
        vault.setDailyLimit(address(usdc), 1000e6);
        vault.setDailyLimit(ETH, 0.1 ether);
        vault.setNewContactLimit(address(usdc), 50e6);
        vault.setPriceSource(address(prices));
        vault.finishSetup();
        vm.stopPrank();
        vm.warp(vm.getBlockTimestamp() + 30 days);
    }

    function list(address item) internal pure returns (address[] memory items) {
        items = new address[](1);
        items[0] = item;
    }

    function act(address target, bytes memory data) internal pure returns (VerbatimVault.Action memory) {
        return VerbatimVault.Action(target, 0, data, 0);
    }

    function only(VerbatimVault.Action memory action) internal pure returns (VerbatimVault.Action[] memory actions) {
        actions = new VerbatimVault.Action[](1);
        actions[0] = action;
    }

    function attackersOwnChecks() internal view returns (VerbatimVault.Check[] memory checks) {
        checks = new VerbatimVault.Check[](2);
        checks[0] = VerbatimVault.Check(VerbatimVault.CheckKind.AtMostLeaves, address(usdc), address(0), ALL_USDC);
        checks[1] = VerbatimVault.Check(VerbatimVault.CheckKind.AtMostLeaves, ETH, address(0), 1 ether);
    }

    function attack(VerbatimVault.Action[] memory actions) internal {
        vm.prank(everydayKey);
        vault.run(actions, attackersOwnChecks(), vm.getBlockTimestamp());
    }

    function routerActions(uint256 amount, bytes memory routerCall)
        internal
        view
        returns (VerbatimVault.Action[] memory actions)
    {
        actions = new VerbatimVault.Action[](3);
        actions[0] = act(address(usdc), abi.encodeCall(TestToken.approve, (PERMIT2, amount)));
        actions[1] = act(
            PERMIT2, abi.encodeCall(IPermit2.approve, (address(usdc), address(router), uint160(amount), uint48(vm.getBlockTimestamp())))
        );
        actions[2] = act(address(router), routerCall);
    }

    function assertNothingStolen() internal view {
        assertEq(usdc.balanceOf(address(vault)), ALL_USDC);
        assertEq(address(vault).balance, 1 ether);
        assertEq(usdc.balanceOf(attacker), 0);
        assertEq(attacker.balance, 0);
        assertEq(usdc.allowance(address(vault), attacker), 0);
    }

    function test_Attack1_DrainToAStranger() public {
        VerbatimVault.Action[] memory drainUsdc = only(act(address(usdc), abi.encodeCall(TestToken.transfer, (attacker, ALL_USDC))));
        vm.expectRevert("Not a saved contact");
        attack(drainUsdc);
        VerbatimVault.Action[] memory drainEth = only(VerbatimVault.Action(attacker, 1 ether, "", 0));
        vm.expectRevert("Not a saved contact");
        attack(drainEth);
        assertNothingStolen();
    }

    function test_Attack2_UnlimitedPermissionForAStranger() public {
        VerbatimVault.Action[] memory approval =
            only(act(address(usdc), abi.encodeCall(TestToken.approve, (attacker, type(uint256).max))));
        vm.expectRevert("Permission for an untrusted contract");
        attack(approval);
        VerbatimVault.Action[] memory permit2Approval = only(
            act(PERMIT2, abi.encodeCall(IPermit2.approve, (address(usdc), attacker, type(uint160).max, type(uint48).max)))
        );
        vm.expectRevert("Permission for an untrusted contract");
        attack(permit2Approval);
        assertNothingStolen();
    }

    function test_Attack3_Takeover() public {
        VerbatimVault.Action[] memory throughTheVault =
            only(act(address(vault), abi.encodeCall(VerbatimVault.saveContact, (attacker))));
        vm.expectRevert("Not a trusted contract");
        attack(throughTheVault);
        VerbatimVault.Action[] memory borrowedCode =
            only(VerbatimVault.Action(attacker, 0, abi.encodeCall(TestToken.transfer, (attacker, ALL_USDC)), 1));
        vm.expectRevert("Borrowed code would run in your account");
        attack(borrowedCode);
        vm.startPrank(everydayKey);
        vm.expectRevert("Only the rules key can set limits");
        vault.setDailyLimit(address(usdc), ALL_USDC);
        vm.expectRevert("Only the rules key can change settings");
        vault.setLooseningWait(0);
        vm.expectRevert("Only the rules key can finish setup");
        vault.finishSetup();
        vm.stopPrank();
        assertEq(vault.everydayKey(), everydayKey);
        assertEq(vault.rulesKey(), rulesKey);
        assertNothingStolen();
    }

    function test_Attack4_SwapOutputSentToTheAttacker() public {
        VerbatimVault.Action[] memory actions =
            routerActions(1000e6, abi.encodeCall(TestRouter.swapTo, (address(usdc), uint160(1000e6), 0.02 ether, attacker)));
        vm.expectRevert("Unfair trade");
        attack(actions);
        assertNothingStolen();
    }

    function test_Attack5_SwapAtATerriblePrice() public {
        VerbatimVault.Action[] memory actions =
            routerActions(1000e6, abi.encodeCall(TestRouter.swap, (address(usdc), uint160(1000e6), 1)));
        vm.expectRevert("Unfair trade");
        attack(actions);
        assertNothingStolen();
    }

    function test_Attack6_AddTheAttackerAsAContact() public {
        vm.prank(everydayKey);
        vm.expectRevert("Only the rules key can save contacts");
        vault.saveContact(attacker);
        VerbatimVault.Action[] memory throughTheVault =
            only(act(address(vault), abi.encodeCall(VerbatimVault.saveContact, (attacker))));
        vm.expectRevert("Not a trusted contract");
        attack(throughTheVault);
        vm.prank(everydayKey);
        vm.expectRevert("Not a saved contact");
        vault.propose(VerbatimVault.ChangeKind.Allowance, attacker, address(usdc), ALL_USDC);
        assertEq(vault.savedAt(attacker), 0);
        assertNothingStolen();
    }

    function test_Attack7_RouterPaysTheAttackerDirectly() public {
        VerbatimVault.Action[] memory actions =
            routerActions(1000e6, abi.encodeCall(TestRouter.sendTo, (address(usdc), uint160(1000e6), attacker)));
        vm.expectRevert("Unfair trade");
        attack(actions);
        assertNothingStolen();
    }

    function test_Attack8_DrainToAHackedContactIsCappedByTheDailyLimit() public {
        VerbatimVault.Action[] memory everything = only(act(address(usdc), abi.encodeCall(TestToken.transfer, (mom, ALL_USDC))));
        vm.expectRevert("Over the daily limit");
        attack(everything);
        attack(only(act(address(usdc), abi.encodeCall(TestToken.transfer, (mom, 1000e6)))));
        VerbatimVault.Action[] memory more = only(act(address(usdc), abi.encodeCall(TestToken.transfer, (mom, 1))));
        vm.expectRevert("Over the daily limit");
        attack(more);
        assertEq(usdc.balanceOf(mom), 1000e6);
        assertEq(usdc.balanceOf(address(vault)), ALL_USDC - 1000e6);
    }

    function test_Attack9_BigAllowanceForAHackedContact() public {
        vm.startPrank(everydayKey);
        uint256 id = vault.propose(VerbatimVault.ChangeKind.Allowance, mom, address(usdc), ALL_USDC);
        vm.expectRevert("Only the rules key can approve");
        vault.approve(id);
        vm.stopPrank();
        vm.warp(vm.getBlockTimestamp() + 365 days);
        vm.prank(everydayKey);
        vm.expectRevert("No allowance for this contact");
        vault.payWithAllowance(mom, ALL_USDC);
        assertEq(usdc.balanceOf(mom), 0);
    }

    function test_Attack10_RaiseTheLimitOrLoosenThePrice() public {
        vm.startPrank(everydayKey);
        uint256 raise = vault.propose(VerbatimVault.ChangeKind.DailyLimit, address(0), address(usdc), ALL_USDC);
        uint256 tolerance = vault.propose(VerbatimVault.ChangeKind.TradeTolerance, address(0), address(0), 10_000);
        uint256 source = vault.propose(VerbatimVault.ChangeKind.PriceSource, address(0), address(0), uint256(uint160(attacker)));
        vm.expectRevert("Only the rules key can change settings");
        vault.setPriceSource(attacker);
        vm.expectRevert("Only the rules key can change settings");
        vault.setTradeTolerance(10_000);
        vm.stopPrank();
        vm.warp(vm.getBlockTimestamp() + 365 days);
        vm.expectRevert("Not approved yet");
        vault.switchOn(raise);
        vm.expectRevert("Not approved yet");
        vault.switchOn(tolerance);
        vm.expectRevert("Not approved yet");
        vault.switchOn(source);
        assertEq(vault.dailyLimit(address(usdc)), 1000e6);
        assertEq(vault.tradeTolerance(), 300);
        assertEq(vault.priceSource(), address(prices));
    }

    function test_NormalUseStillWorks() public {
        VerbatimVault.Check[] memory payChecks = new VerbatimVault.Check[](2);
        payChecks[0] = VerbatimVault.Check(VerbatimVault.CheckKind.AtMostLeaves, address(usdc), address(0), 100e6);
        payChecks[1] = VerbatimVault.Check(VerbatimVault.CheckKind.ExactlyTo, address(usdc), mom, 100e6);
        vm.prank(everydayKey);
        vault.run(only(act(address(usdc), abi.encodeCall(TestToken.transfer, (mom, 100e6)))), payChecks, vm.getBlockTimestamp());
        VerbatimVault.Check[] memory swapChecks = new VerbatimVault.Check[](2);
        swapChecks[0] = VerbatimVault.Check(VerbatimVault.CheckKind.AtMostLeaves, address(usdc), address(0), 100e6);
        swapChecks[1] = VerbatimVault.Check(VerbatimVault.CheckKind.AtLeastArrives, ETH, address(0), 0.00194 ether);
        vm.prank(everydayKey);
        vault.run(
            routerActions(100e6, abi.encodeCall(TestRouter.swap, (address(usdc), uint160(100e6), 0.002 ether))),
            swapChecks,
            vm.getBlockTimestamp()
        );
        assertEq(usdc.balanceOf(mom), 100e6);
        assertEq(usdc.balanceOf(address(vault)), ALL_USDC - 200e6);
        assertEq(address(vault).balance, 1.002 ether);
    }
}

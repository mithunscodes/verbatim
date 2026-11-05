// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {VerbatimVault} from "../src/VerbatimVault.sol";
import {TestToken} from "./TestToken.sol";
import {TestRouter} from "./TestRouter.sol";
import {LeakyVault} from "./LeakyVault.sol";

contract ContactsTest is Test {
    address constant ETH = address(0);

    VerbatimVault vault;
    TestToken usdc;
    TestRouter router;
    address everydayKey = makeAddr("everydayKey");
    address rulesKey = makeAddr("rulesKey");
    address mom = makeAddr("mom");
    address dad = makeAddr("dad");
    address stranger = makeAddr("stranger");
    uint256 deadline;

    event ContactSaved(address indexed contact);

    function setUp() public {
        usdc = new TestToken();
        router = new TestRouter();
        vault = new VerbatimVault(everydayKey, rulesKey, list(address(usdc)), list(address(router)));
        usdc.mint(address(vault), 100e6);
        vm.deal(address(vault), 1 ether);
        vm.startPrank(rulesKey);
        vault.saveContact(mom);
        vault.setDailyLimit(address(usdc), 100e6);
        vault.setDailyLimit(ETH, 1 ether);
        vm.stopPrank();
        deadline = block.timestamp + 5 minutes;
    }

    function list(address item) internal pure returns (address[] memory items) {
        items = new address[](1);
        items[0] = item;
    }

    function sendUsdc(address to, uint256 amount) internal view returns (VerbatimVault.Action memory) {
        return VerbatimVault.Action(address(usdc), 0, abi.encodeCall(TestToken.transfer, (to, amount)), 0);
    }

    function sendEth(address to, uint256 amount) internal pure returns (VerbatimVault.Action memory) {
        return VerbatimVault.Action(to, amount, "", 0);
    }

    function only(VerbatimVault.Action memory action) internal pure returns (VerbatimVault.Action[] memory actions) {
        actions = new VerbatimVault.Action[](1);
        actions[0] = action;
    }

    function noChecks() internal pure returns (VerbatimVault.Check[] memory) {
        return new VerbatimVault.Check[](0);
    }

    function limit(address token, uint256 amount) internal pure returns (VerbatimVault.Check[] memory checks) {
        checks = new VerbatimVault.Check[](1);
        checks[0] = VerbatimVault.Check(VerbatimVault.CheckKind.AtMostLeaves, token, address(0), amount);
    }

    function runAsEverydayKey(VerbatimVault.Action[] memory actions, VerbatimVault.Check[] memory checks) internal {
        vm.prank(everydayKey);
        vault.run(actions, checks, deadline);
    }

    function assertNothingMoved() internal view {
        assertEq(usdc.balanceOf(address(vault)), 100e6);
        assertEq(address(vault).balance, 1 ether);
    }

    function test_SendToSavedContactPasses() public {
        runAsEverydayKey(only(sendUsdc(mom, 2e6)), limit(address(usdc), 2e6));
        assertEq(usdc.balanceOf(mom), 2e6);
        assertEq(usdc.balanceOf(address(vault)), 98e6);
    }

    function test_SendToStrangerFails() public {
        vm.expectRevert("Not a saved contact");
        runAsEverydayKey(only(sendUsdc(stranger, 2e6)), limit(address(usdc), 2e6));
        assertEq(usdc.balanceOf(stranger), 0);
        assertNothingMoved();
    }

    function test_EthToSavedContactPasses() public {
        runAsEverydayKey(only(sendEth(mom, 0.1 ether)), limit(ETH, 0.1 ether));
        assertEq(mom.balance, 0.1 ether);
        assertEq(address(vault).balance, 0.9 ether);
    }

    function test_EthToStrangerFails() public {
        vm.expectRevert("Not a saved contact");
        runAsEverydayKey(only(sendEth(stranger, 0.1 ether)), limit(ETH, 0.1 ether));
        assertEq(stranger.balance, 0);
        assertNothingMoved();
    }

    function test_HiddenSendToStrangerFailsEvenWithinYourLimit() public {
        VerbatimVault.Action[] memory actions = new VerbatimVault.Action[](2);
        actions[0] = sendUsdc(mom, 2e6);
        actions[1] = sendUsdc(stranger, 2e6);
        vm.expectRevert("Not a saved contact");
        runAsEverydayKey(actions, limit(address(usdc), 4e6));
        assertEq(usdc.balanceOf(mom), 0);
        assertEq(usdc.balanceOf(stranger), 0);
        assertNothingMoved();
    }

    function test_EverydayKeyIsNotAContact() public {
        vm.expectRevert("Not a saved contact");
        runAsEverydayKey(only(sendUsdc(everydayKey, 100e6)), limit(address(usdc), 100e6));
        vm.expectRevert("Not a saved contact");
        runAsEverydayKey(only(sendEth(everydayKey, 1 ether)), limit(ETH, 1 ether));
        assertNothingMoved();
    }

    function test_TrustedContractIsNotAContact() public {
        vm.expectRevert("Not a saved contact");
        runAsEverydayKey(only(sendUsdc(address(router), 100e6)), limit(address(usdc), 100e6));
        vm.expectRevert("Not a saved contact");
        runAsEverydayKey(only(sendEth(address(router), 1 ether)), limit(ETH, 1 ether));
        assertNothingMoved();
    }

    function test_NewContactWorksOnceSaved() public {
        vm.expectRevert("Not a saved contact");
        runAsEverydayKey(only(sendUsdc(dad, 2e6)), limit(address(usdc), 2e6));
        vm.expectEmit(address(vault));
        emit ContactSaved(dad);
        vm.prank(rulesKey);
        vault.saveContact(dad);
        assertEq(vault.contacts(1), dad);
        runAsEverydayKey(only(sendUsdc(dad, 2e6)), limit(address(usdc), 2e6));
        assertEq(usdc.balanceOf(dad), 2e6);
    }

    function test_OnlyTheRulesKeyCanSaveContacts() public {
        vm.prank(everydayKey);
        vm.expectRevert("Only the rules key can save contacts");
        vault.saveContact(stranger);
        vm.prank(stranger);
        vm.expectRevert("Only the rules key can save contacts");
        vault.saveContact(stranger);
        vm.expectRevert("Not a saved contact");
        runAsEverydayKey(only(sendUsdc(stranger, 2e6)), limit(address(usdc), 2e6));
    }

    function test_EverydayKeyCantSaveAContactThroughTheVault() public {
        VerbatimVault.Action memory sneaky =
            VerbatimVault.Action(address(vault), 0, abi.encodeCall(VerbatimVault.saveContact, (stranger)), 0);
        vm.expectRevert("Not a trusted contract");
        runAsEverydayKey(only(sneaky), noChecks());
    }

    function test_ContactsCantChangeDuringARun() public {
        LeakyVault leaky = new LeakyVault(everydayKey, rulesKey, list(address(usdc)));
        VerbatimVault.Action memory sneaky =
            VerbatimVault.Action(address(leaky), 0, abi.encodeCall(LeakyVault.addContact, (stranger)), 0);
        vm.prank(everydayKey);
        vm.expectRevert("Your account would change");
        leaky.run(only(sneaky), noChecks(), deadline);
    }

    function test_RevertWhen_ContactEmptyOrAlreadySaved() public {
        vm.startPrank(rulesKey);
        vm.expectRevert("A contact can't be empty");
        vault.saveContact(address(0));
        vm.expectRevert("Already a saved contact");
        vault.saveContact(mom);
        vm.stopPrank();
    }
}

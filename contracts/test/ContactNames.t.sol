// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {VerbatimVault} from "../src/VerbatimVault.sol";
import {TestDirectory} from "./TestDirectory.sol";
import {TestToken} from "./TestToken.sol";
import {TestRouter} from "./TestRouter.sol";

contract ContactNamesTest is Test {
    string constant RAVI = "ravi.alice.eth";
    address constant ETH = address(0);

    VerbatimVault vault;
    TestDirectory directory;
    TestToken usdc;
    TestRouter router;
    address everydayKey = makeAddr("everydayKey");
    address rulesKey = makeAddr("rulesKey");
    address mom = makeAddr("mom");
    address ravi = makeAddr("ravi");
    address raviNew = makeAddr("raviNew");
    address thief = makeAddr("thief");

    event ContactSaved(address indexed contact);
    event ContactNamed(address indexed contact, string name);

    function setUp() public {
        usdc = new TestToken();
        router = new TestRouter();
        address[] memory trusted = new address[](1);
        trusted[0] = address(router);
        directory = new TestDirectory(trusted);
        directory.setName(RAVI, ravi);
        address[] memory watched = new address[](1);
        watched[0] = address(usdc);
        vault = new VerbatimVault(everydayKey, rulesKey, watched, address(directory));
        usdc.mint(address(vault), 2000e6);
        vm.deal(address(vault), 1 ether);
        vm.startPrank(rulesKey);
        vault.saveContact(mom);
        vault.saveContactName(RAVI);
        vault.setDailyLimit(address(usdc), 1000e6);
        vault.setDailyLimit(ETH, 1 ether);
        vault.setNewContactLimit(address(usdc), 50e6);
        vault.setNewContactLimit(ETH, 0.02 ether);
        vault.finishSetup();
        vm.stopPrank();
        vm.warp(vm.getBlockTimestamp() + 30 days);
    }

    function pay(address to, uint256 amount) internal {
        VerbatimVault.Action[] memory actions = new VerbatimVault.Action[](1);
        actions[0] = VerbatimVault.Action(address(usdc), 0, abi.encodeCall(TestToken.transfer, (to, amount)), 0);
        VerbatimVault.Check[] memory checks = new VerbatimVault.Check[](1);
        checks[0] = VerbatimVault.Check(VerbatimVault.CheckKind.AtMostLeaves, address(usdc), address(0), amount);
        vm.prank(everydayKey);
        vault.run(actions, checks, vm.getBlockTimestamp());
    }

    function payEth(address to, uint256 amount) internal {
        VerbatimVault.Action[] memory actions = new VerbatimVault.Action[](1);
        actions[0] = VerbatimVault.Action(to, amount, "", 0);
        VerbatimVault.Check[] memory checks = new VerbatimVault.Check[](1);
        checks[0] = VerbatimVault.Check(VerbatimVault.CheckKind.AtMostLeaves, ETH, address(0), amount);
        vm.prank(everydayKey);
        vault.run(actions, checks, vm.getBlockTimestamp());
    }

    function proposeNewAddress(address contact, address next) internal returns (uint256 id) {
        vm.prank(everydayKey);
        id = vault.propose(VerbatimVault.ChangeKind.ContactAddress, contact, address(0), uint256(uint160(next)));
    }

    function approve(uint256 id) internal {
        vm.prank(rulesKey);
        vault.approve(id);
    }

    function test_SavingANamePinsItsAddress() public {
        assertEq(vault.nameOf(ravi), RAVI);
        assertEq(vault.pinnedAddress(keccak256(bytes(RAVI))), ravi);
        assertEq(vault.contacts(1), ravi);
        directory.setName("vendor.alice.eth", makeAddr("vendor"));
        vm.expectEmit(true, false, false, false);
        emit ContactSaved(makeAddr("vendor"));
        vm.expectEmit(true, false, false, true);
        emit ContactNamed(makeAddr("vendor"), "vendor.alice.eth");
        vm.prank(rulesKey);
        vault.saveContactName("vendor.alice.eth");
        assertEq(vault.savedAt(makeAddr("vendor")), vm.getBlockTimestamp());
    }

    function test_SendToNamedContactWorks() public {
        pay(ravi, 100e6);
        payEth(ravi, 0.1 ether);
        assertEq(usdc.balanceOf(ravi), 100e6);
        assertEq(ravi.balance, 0.1 ether);
    }

    function test_RevertWhen_SendToUnsavedAddress() public {
        vm.expectRevert("Not a saved contact");
        pay(thief, 1e6);
    }

    function test_RevertWhen_NameHasNoAddress() public {
        vm.prank(rulesKey);
        vm.expectRevert("This name has no address");
        vault.saveContactName("nobody.alice.eth");
    }

    function test_RevertWhen_NotTheRulesKey() public {
        directory.setName("vendor.alice.eth", makeAddr("vendor"));
        vm.prank(everydayKey);
        vm.expectRevert("Only the rules key can save contacts");
        vault.saveContactName("vendor.alice.eth");
    }

    function test_RevertWhen_NamePointsToATrustedContract() public {
        directory.setName("router.alice.eth", address(router));
        directory.setName("usdc.alice.eth", address(usdc));
        vm.startPrank(rulesKey);
        vm.expectRevert("A token or trusted contract can't be a contact");
        vault.saveContactName("router.alice.eth");
        vm.expectRevert("A token or trusted contract can't be a contact");
        vault.saveContactName("usdc.alice.eth");
        vm.stopPrank();
    }

    function test_RevertWhen_NameMovedThenSend() public {
        directory.setName(RAVI, thief);
        vm.expectRevert("This contact's address changed");
        pay(ravi, 1e6);
        vm.expectRevert("This contact's address changed");
        payEth(ravi, 0.01 ether);
        vm.expectRevert("Not a saved contact");
        pay(thief, 1e6);
        assertEq(usdc.balanceOf(ravi), 0);
        assertEq(usdc.balanceOf(thief), 0);
    }

    function test_RevertWhen_NameMovedThenSavedAgain() public {
        directory.setName(RAVI, thief);
        vm.prank(rulesKey);
        vm.expectRevert("This name is already saved");
        vault.saveContactName(RAVI);
    }

    function test_NameMovedBackWorksAgain() public {
        directory.setName(RAVI, thief);
        vm.expectRevert("This contact's address changed");
        pay(ravi, 1e6);
        directory.setName(RAVI, ravi);
        pay(ravi, 1e6);
        assertEq(usdc.balanceOf(ravi), 1e6);
    }

    function test_RevertWhen_NameMovedThenAllowanceUsed() public {
        vm.prank(everydayKey);
        uint256 id = vault.propose(VerbatimVault.ChangeKind.Allowance, ravi, address(usdc), 500e6);
        approve(id);
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        directory.setName(RAVI, thief);
        vm.prank(everydayKey);
        vm.expectRevert("This contact's address changed");
        vault.payWithAllowance(ravi, 500e6);
    }

    function test_ReapprovalWaitsThenCapsAt50() public {
        directory.setName(RAVI, raviNew);
        uint256 id = proposeNewAddress(ravi, raviNew);
        approve(id);
        vm.expectRevert("Not a saved contact");
        pay(raviNew, 1e6);
        vm.expectRevert("Still waiting");
        vault.switchOn(id);
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        vm.expectRevert("Not a saved contact");
        pay(raviNew, 1e6);
        vault.switchOn(id);
        assertEq(vault.nameOf(raviNew), RAVI);
        assertEq(vault.pinnedAddress(keccak256(bytes(RAVI))), raviNew);
        assertEq(vault.savedAt(raviNew), vm.getBlockTimestamp());
        pay(raviNew, 50e6);
        vm.expectRevert("Over the new-contact limit");
        pay(raviNew, 1e6);
        vm.expectRevert("This contact's address changed");
        pay(ravi, 1e6);
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        pay(raviNew, 100e6);
        assertEq(usdc.balanceOf(raviNew), 150e6);
    }

    function test_RevertWhen_ReapprovedContactGetsAnAllowanceTooSoon() public {
        directory.setName(RAVI, raviNew);
        uint256 id = proposeNewAddress(ravi, raviNew);
        approve(id);
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        vault.switchOn(id);
        vm.prank(everydayKey);
        uint256 allowance = vault.propose(VerbatimVault.ChangeKind.Allowance, raviNew, address(usdc), 500e6);
        vm.prank(rulesKey);
        vm.expectRevert("Contact too new for big payments");
        vault.approve(allowance);
    }

    function test_RevertWhen_ProposingABadAddressChange() public {
        directory.setName(RAVI, raviNew);
        vm.startPrank(everydayKey);
        vm.expectRevert("Not a saved name");
        vault.propose(VerbatimVault.ChangeKind.ContactAddress, mom, address(0), uint256(uint160(raviNew)));
        vm.expectRevert("Not an address");
        vault.propose(VerbatimVault.ChangeKind.ContactAddress, ravi, address(0), 0);
        vm.expectRevert("The name doesn't point there");
        vault.propose(VerbatimVault.ChangeKind.ContactAddress, ravi, address(0), uint256(uint160(thief)));
        vm.stopPrank();
        directory.setName(RAVI, mom);
        vm.prank(everydayKey);
        vm.expectRevert("Already a saved contact");
        vault.propose(VerbatimVault.ChangeKind.ContactAddress, ravi, address(0), uint256(uint160(mom)));
    }

    function test_RevertWhen_NameMovesAgainDuringTheWait() public {
        directory.setName(RAVI, raviNew);
        uint256 id = proposeNewAddress(ravi, raviNew);
        approve(id);
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        directory.setName(RAVI, thief);
        vm.expectRevert("This contact's address changed");
        vault.switchOn(id);
    }

    function test_RevertWhen_ReapprovalNotApprovedCancelledOrExpired() public {
        directory.setName(RAVI, raviNew);
        uint256 id = proposeNewAddress(ravi, raviNew);
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        vm.expectRevert("Not approved yet");
        vault.switchOn(id);
        approve(id);
        vm.warp(vm.getBlockTimestamp() + 24 hours + 48 hours + 1);
        vm.expectRevert("Change expired");
        vault.switchOn(id);
        uint256 second = proposeNewAddress(ravi, raviNew);
        approve(second);
        vm.prank(rulesKey);
        vault.cancel(second);
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        vm.expectRevert("Change cancelled");
        vault.switchOn(second);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {VerbatimVault} from "../src/VerbatimVault.sol";
import {TestToken} from "./TestToken.sol";
import {TestMultisig} from "./TestMultisig.sol";
import {LeakyVault} from "./LeakyVault.sol";

contract SlowLooseningTest is Test {
    uint256 constant MILLION = 1_000_000e6;

    VerbatimVault vault;
    TestToken usdc;
    address everydayKey = makeAddr("everydayKey");
    address rulesKey = makeAddr("rulesKey");
    address warmWallet = makeAddr("warmWallet");
    address vendor = makeAddr("vendor");
    address stranger = makeAddr("stranger");

    event SetupFinished();
    event ChangeProposed(uint256 indexed id, VerbatimVault.ChangeKind kind, address contact, address token, uint256 value);
    event ChangeApproved(uint256 indexed id, uint256 readyAt);
    event ChangeCancelled(uint256 indexed id);
    event ChangeSwitchedOn(uint256 indexed id);

    function setUp() public {
        usdc = new TestToken();
        vault = new VerbatimVault(everydayKey, rulesKey, list(address(usdc)), new address[](0));
        usdc.mint(address(vault), 2 * MILLION);
        vm.startPrank(rulesKey);
        vault.saveContact(warmWallet);
        vault.saveContact(vendor);
        vault.setDailyLimit(address(usdc), 10_000e6);
        vault.setNewContactLimit(address(usdc), 50e6);
        vault.finishSetup();
        vm.stopPrank();
        vm.warp(block.timestamp + 30 days);
    }

    function list(address item) internal pure returns (address[] memory items) {
        items = new address[](1);
        items[0] = item;
    }

    function propose(VerbatimVault.ChangeKind kind, address contact, address token, uint256 value)
        internal
        returns (uint256 id)
    {
        vm.prank(everydayKey);
        id = vault.propose(kind, contact, token, value);
    }

    function proposeLimit(uint256 amount) internal returns (uint256) {
        return propose(VerbatimVault.ChangeKind.DailyLimit, address(0), address(usdc), amount);
    }

    function proposeMillion(address contact) internal returns (uint256) {
        return propose(VerbatimVault.ChangeKind.Allowance, contact, address(usdc), MILLION);
    }

    function approve(uint256 id) internal {
        vm.prank(rulesKey);
        vault.approve(id);
    }

    function cancel(uint256 id) internal {
        vm.prank(rulesKey);
        vault.cancel(id);
    }

    function pay(address contact, uint256 amount) internal {
        vm.prank(everydayKey);
        vault.payWithAllowance(contact, amount);
    }

    function send(VerbatimVault target, address to, uint256 amount) internal {
        VerbatimVault.Action[] memory actions = new VerbatimVault.Action[](1);
        actions[0] = VerbatimVault.Action(address(usdc), 0, abi.encodeCall(TestToken.transfer, (to, amount)), 0);
        VerbatimVault.Check[] memory checks = new VerbatimVault.Check[](1);
        checks[0] = VerbatimVault.Check(VerbatimVault.CheckKind.AtMostLeaves, address(usdc), address(0), amount);
        vm.prank(everydayKey);
        target.run(actions, checks, block.timestamp);
    }

    function readyAtOf(VerbatimVault target, uint256 id) internal view returns (uint256 readyAt) {
        (,,,,, readyAt,,) = target.changes(id);
    }

    function test_MillionAllowance_OneSendBetween24And72HoursAfterApproval() public {
        uint256 id = proposeMillion(warmWallet);
        uint256 approvedAt = block.timestamp;
        approve(id);
        vm.warp(approvedAt + 24 hours);
        pay(warmWallet, MILLION);
        assertEq(usdc.balanceOf(warmWallet), MILLION);
        assertEq(vault.leftToday(address(usdc)), 10_000e6);
    }

    function test_MillionAllowance_StillWorksAt72Hours() public {
        uint256 approvedAt = block.timestamp;
        approve(proposeMillion(warmWallet));
        vm.warp(approvedAt + 72 hours);
        pay(warmWallet, 400_000e6);
        assertEq(usdc.balanceOf(warmWallet), 400_000e6);
    }

    function test_MillionAllowance_DifferentContactFails() public {
        approve(proposeMillion(warmWallet));
        vm.warp(block.timestamp + 24 hours);
        vm.expectRevert("No allowance for this contact");
        pay(vendor, MILLION);
        vm.expectRevert("No allowance for this contact");
        pay(stranger, MILLION);
    }

    function test_MillionAllowance_SecondUseFails() public {
        approve(proposeMillion(warmWallet));
        vm.warp(block.timestamp + 24 hours);
        pay(warmWallet, 600_000e6);
        vm.expectRevert("Allowance already used");
        pay(warmWallet, 400_000e6);
        assertEq(usdc.balanceOf(warmWallet), 600_000e6);
    }

    function test_MillionAllowance_ExpiresAfter72Hours() public {
        uint256 approvedAt = block.timestamp;
        approve(proposeMillion(warmWallet));
        vm.warp(approvedAt + 72 hours + 1);
        vm.expectRevert("Allowance expired");
        pay(warmWallet, MILLION);
    }

    function test_MillionAllowance_NotActiveBeforeTheWaitEnds() public {
        uint256 approvedAt = block.timestamp;
        approve(proposeMillion(warmWallet));
        vm.expectRevert("Allowance not active yet");
        pay(warmWallet, MILLION);
        vm.warp(approvedAt + 24 hours - 1);
        vm.expectRevert("Allowance not active yet");
        pay(warmWallet, MILLION);
        assertEq(usdc.balanceOf(warmWallet), 0);
    }

    function test_ProposingAndApprovingAreAnnounced() public {
        vm.expectEmit(address(vault));
        emit ChangeProposed(0, VerbatimVault.ChangeKind.Allowance, warmWallet, address(usdc), MILLION);
        uint256 id = proposeMillion(warmWallet);
        assertEq(id, 0);
        assertEq(vault.changeCount(), 1);
        vm.expectEmit(address(vault));
        emit ChangeApproved(id, block.timestamp + 24 hours);
        approve(id);
        assertEq(readyAtOf(vault, id), block.timestamp + 24 hours);
    }

    function test_PhoneCancelsBeforeApproving() public {
        uint256 id = proposeMillion(warmWallet);
        vm.expectEmit(address(vault));
        emit ChangeCancelled(id);
        cancel(id);
        vm.prank(rulesKey);
        vm.expectRevert("Change cancelled");
        vault.approve(id);
        vm.prank(rulesKey);
        vm.expectRevert("Change cancelled");
        vault.cancel(id);
    }

    function test_PhoneCancelsDuringTheWait() public {
        uint256 id = proposeMillion(warmWallet);
        approve(id);
        vm.warp(block.timestamp + 12 hours);
        cancel(id);
        vm.warp(block.timestamp + 12 hours);
        vm.expectRevert("No allowance for this contact");
        pay(warmWallet, MILLION);
    }

    function test_PhoneCancelsALimitRaiseDuringTheWait() public {
        uint256 id = proposeLimit(50_000e6);
        approve(id);
        cancel(id);
        vm.warp(block.timestamp + 24 hours);
        vm.expectRevert("Change cancelled");
        vault.switchOn(id);
        assertEq(vault.dailyLimit(address(usdc)), 10_000e6);
    }

    function test_OnlyThePhoneCancels() public {
        uint256 id = proposeMillion(warmWallet);
        vm.prank(everydayKey);
        vm.expectRevert("Only the rules key can cancel");
        vault.cancel(id);
        vm.prank(stranger);
        vm.expectRevert("Only the rules key can cancel");
        vault.cancel(id);
    }

    function test_CantCancelAUsedAllowance() public {
        uint256 id = proposeMillion(warmWallet);
        approve(id);
        vm.warp(block.timestamp + 24 hours);
        pay(warmWallet, MILLION);
        vm.prank(rulesKey);
        vm.expectRevert("Allowance already used or replaced");
        vault.cancel(id);
    }

    function test_CancellingAnOldAllowanceLeavesItsReplacementAlone() public {
        uint256 first = proposeMillion(warmWallet);
        approve(first);
        vm.warp(block.timestamp + 1 hours);
        uint256 second = propose(VerbatimVault.ChangeKind.Allowance, warmWallet, address(usdc), 300_000e6);
        approve(second);
        vm.prank(rulesKey);
        vm.expectRevert("Allowance already used or replaced");
        vault.cancel(first);
        vm.warp(block.timestamp + 24 hours);
        vm.expectRevert("More than the allowance");
        pay(warmWallet, MILLION);
        pay(warmWallet, 300_000e6);
        assertEq(usdc.balanceOf(warmWallet), 300_000e6);
    }

    function test_LimitRaiseWaits24HoursThenAnyoneCanSwitchItOn() public {
        uint256 id = proposeLimit(50_000e6);
        uint256 approvedAt = block.timestamp;
        approve(id);
        vm.expectRevert("Still waiting");
        vault.switchOn(id);
        vm.warp(approvedAt + 24 hours - 1);
        vm.expectRevert("Still waiting");
        vault.switchOn(id);
        assertEq(vault.dailyLimit(address(usdc)), 10_000e6);
        vm.warp(approvedAt + 24 hours);
        vm.expectEmit(address(vault));
        emit ChangeSwitchedOn(id);
        vm.prank(stranger);
        vault.switchOn(id);
        assertEq(vault.dailyLimit(address(usdc)), 50_000e6);
        vm.expectRevert("Already switched on");
        vault.switchOn(id);
        vm.prank(rulesKey);
        vm.expectRevert("Already switched on");
        vault.cancel(id);
    }

    function test_EverydayKeyAloneCantLoosenAnything() public {
        vm.startPrank(everydayKey);
        vm.expectRevert("Only the rules key can set limits");
        vault.setDailyLimit(address(usdc), 2 * MILLION);
        vm.expectRevert("Only the rules key can set limits");
        vault.setNewContactLimit(address(usdc), 2 * MILLION);
        vm.expectRevert("Only the rules key can change settings");
        vault.setAllowanceValidity(365 days);
        vm.expectRevert("Only the rules key can change settings");
        vault.setNewContactPeriod(0);
        vm.expectRevert("Only the rules key can change settings");
        vault.setAllowanceMinAge(0);
        vm.expectRevert("Only the rules key can change settings");
        vault.setLooseningWait(0);
        vm.expectRevert("Only the rules key can finish setup");
        vault.finishSetup();
        uint256 raise = vault.propose(VerbatimVault.ChangeKind.DailyLimit, address(0), address(usdc), 2 * MILLION);
        uint256 allowance = vault.propose(VerbatimVault.ChangeKind.Allowance, vendor, address(usdc), MILLION);
        vm.expectRevert("Only the rules key can approve");
        vault.approve(raise);
        vm.expectRevert("Only the rules key can approve");
        vault.approve(allowance);
        vm.stopPrank();
        vm.warp(block.timestamp + 365 days);
        vm.expectRevert("Not approved yet");
        vault.switchOn(raise);
        vm.expectRevert("No allowance for this contact");
        pay(vendor, MILLION);
        assertEq(vault.dailyLimit(address(usdc)), 10_000e6);
        assertEq(usdc.balanceOf(address(vault)), 2 * MILLION);
    }

    function test_PhoneTightensAtOnce() public {
        vm.startPrank(rulesKey);
        vault.setDailyLimit(address(usdc), 0);
        vault.setNewContactLimit(address(usdc), 10e6);
        vault.setAllowanceValidity(1 hours);
        vault.setNewContactPeriod(7 days);
        vault.setAllowanceMinAge(30 days);
        vault.setLooseningWait(7 days);
        vm.stopPrank();
        assertEq(vault.dailyLimit(address(usdc)), 0);
        assertEq(vault.newContactLimit(address(usdc)), 10e6);
        assertEq(vault.allowanceValidity(), 1 hours);
        assertEq(vault.newContactPeriod(), 7 days);
        assertEq(vault.allowanceMinAge(), 30 days);
        assertEq(vault.looseningWait(), 7 days);
        vm.expectRevert("Over the daily limit");
        send(vault, warmWallet, 1);
    }

    function test_PhoneCantLoosenAloneAfterSetup() public {
        vm.startPrank(rulesKey);
        vm.expectRevert("Loosening needs a proposal");
        vault.setDailyLimit(address(usdc), 10_000e6 + 1);
        vm.expectRevert("Loosening needs a proposal");
        vault.setNewContactLimit(address(usdc), 50e6 + 1);
        vm.expectRevert("Loosening needs a proposal");
        vault.setAllowanceValidity(48 hours + 1);
        vm.expectRevert("Loosening needs a proposal");
        vault.setNewContactPeriod(24 hours - 1);
        vm.expectRevert("Loosening needs a proposal");
        vault.setAllowanceMinAge(7 days - 1);
        vm.expectRevert("Loosening needs a proposal");
        vault.setLooseningWait(24 hours - 1);
        vault.setDailyLimit(address(usdc), 10_000e6);
        vm.stopPrank();
    }

    function test_EmergencyTighteningBeatsAnOldApproval() public {
        uint256 id = proposeLimit(50_000e6);
        approve(id);
        vm.warp(block.timestamp + 12 hours);
        vm.prank(rulesKey);
        vault.setDailyLimit(address(usdc), 0);
        vm.warp(block.timestamp + 12 hours);
        vm.expectRevert("This rule changed during the wait");
        vault.switchOn(id);
        assertEq(vault.dailyLimit(address(usdc)), 0);
    }

    function test_TwoRaisesOfTheSameRuleCantBothSwitchOn() public {
        uint256 first = proposeLimit(20_000e6);
        uint256 second = proposeLimit(30_000e6);
        approve(first);
        approve(second);
        vm.warp(block.timestamp + 24 hours);
        vault.switchOn(first);
        vm.expectRevert("This rule changed during the wait");
        vault.switchOn(second);
        assertEq(vault.dailyLimit(address(usdc)), 20_000e6);
    }

    function test_EverySettingCanBeLoosenedThroughAProposal() public {
        uint256[5] memory ids = [
            propose(VerbatimVault.ChangeKind.NewContactLimit, address(0), address(usdc), 500e6),
            propose(VerbatimVault.ChangeKind.AllowanceValidity, address(0), address(0), 72 hours),
            propose(VerbatimVault.ChangeKind.NewContactPeriod, address(0), address(0), 1 hours),
            propose(VerbatimVault.ChangeKind.AllowanceMinAge, address(0), address(0), 1 days),
            propose(VerbatimVault.ChangeKind.LooseningWait, address(0), address(0), 1 hours)
        ];
        for (uint256 i = 0; i < ids.length; i++) {
            approve(ids[i]);
        }
        vm.warp(block.timestamp + 24 hours);
        for (uint256 i = 0; i < ids.length; i++) {
            vault.switchOn(ids[i]);
        }
        assertEq(vault.newContactLimit(address(usdc)), 500e6);
        assertEq(vault.allowanceValidity(), 72 hours);
        assertEq(vault.newContactPeriod(), 1 hours);
        assertEq(vault.allowanceMinAge(), 1 days);
        assertEq(vault.looseningWait(), 1 hours);
        uint256 next = proposeLimit(20_000e6);
        approve(next);
        vm.warp(block.timestamp + 1 hours);
        vault.switchOn(next);
        assertEq(vault.dailyLimit(address(usdc)), 20_000e6);
    }

    function test_ProposalsAreChecked() public {
        TestToken unwatched = new TestToken();
        vm.startPrank(everydayKey);
        vm.expectRevert("Not a watched token");
        vault.propose(VerbatimVault.ChangeKind.DailyLimit, address(0), address(unwatched), 1);
        vm.expectRevert("Not a watched token");
        vault.propose(VerbatimVault.ChangeKind.NewContactLimit, address(0), address(unwatched), 1);
        vm.stopPrank();
        vm.expectRevert("No such change");
        vault.switchOn(0);
        uint256 id = proposeMillion(warmWallet);
        vm.expectRevert("Allowances switch on by themselves");
        vault.switchOn(id);
        approve(id);
        vm.prank(rulesKey);
        vm.expectRevert("Already approved");
        vault.approve(id);
    }

    function test_NothingMovesBeforeSetupIsFinished() public {
        VerbatimVault fresh = new VerbatimVault(everydayKey, rulesKey, list(address(usdc)), new address[](0));
        usdc.mint(address(fresh), 100e6);
        vm.startPrank(rulesKey);
        fresh.setNewContactPeriod(0);
        fresh.setLooseningWait(2 minutes);
        fresh.saveContact(warmWallet);
        fresh.setDailyLimit(address(usdc), 100e6);
        fresh.setDailyLimit(address(usdc), 200e6);
        vm.stopPrank();
        vm.expectRevert("Finish setting up first");
        send(fresh, warmWallet, 5e6);
        vm.prank(everydayKey);
        vm.expectRevert("Finish setting up first");
        fresh.payWithAllowance(warmWallet, 1);
        vm.prank(everydayKey);
        vm.expectRevert("Only the rules key can finish setup");
        fresh.finishSetup();
        vm.expectEmit(address(fresh));
        emit SetupFinished();
        vm.prank(rulesKey);
        fresh.finishSetup();
        assertTrue(fresh.setupFinished());
        vm.prank(rulesKey);
        vm.expectRevert("Setup already finished");
        fresh.finishSetup();
        send(fresh, warmWallet, 5e6);
        assertEq(usdc.balanceOf(warmWallet), 5e6);
        vm.prank(rulesKey);
        vm.expectRevert("Loosening needs a proposal");
        fresh.setDailyLimit(address(usdc), 300e6);
    }

    function test_AContractCanBeThePhoneKey() public {
        address firstManager = makeAddr("firstManager");
        address secondManager = makeAddr("secondManager");
        TestMultisig managers = new TestMultisig(firstManager, secondManager);
        VerbatimVault team = new VerbatimVault(everydayKey, address(managers), list(address(usdc)), new address[](0));
        bytes memory finish = abi.encodeCall(VerbatimVault.finishSetup, ());
        vm.prank(firstManager);
        managers.submit(address(team), finish);
        assertFalse(team.setupFinished());
        vm.prank(secondManager);
        managers.submit(address(team), finish);
        assertTrue(team.setupFinished());
        vm.prank(everydayKey);
        uint256 id = team.propose(VerbatimVault.ChangeKind.DailyLimit, address(0), address(usdc), 100e6);
        bytes memory approval = abi.encodeCall(VerbatimVault.approve, (id));
        vm.prank(firstManager);
        managers.submit(address(team), approval);
        assertEq(readyAtOf(team, id), 0);
        vm.prank(stranger);
        vm.expectRevert("Not an owner");
        managers.submit(address(team), approval);
        vm.prank(secondManager);
        managers.submit(address(team), approval);
        assertEq(readyAtOf(team, id), block.timestamp + 24 hours);
    }

    function test_WaitAndSetupCantChangeDuringARun() public {
        LeakyVault leaky = new LeakyVault(everydayKey, rulesKey, list(address(usdc)));
        vm.prank(rulesKey);
        leaky.finishSetup();
        bytes[2] memory sneaky =
            [abi.encodeCall(LeakyVault.shortenLooseningWait, (0)), abi.encodeCall(LeakyVault.reopenSetup, ())];
        for (uint256 i = 0; i < sneaky.length; i++) {
            VerbatimVault.Action[] memory actions = new VerbatimVault.Action[](1);
            actions[0] = VerbatimVault.Action(address(leaky), 0, sneaky[i], 0);
            vm.prank(everydayKey);
            vm.expectRevert("Your account would change");
            leaky.run(actions, new VerbatimVault.Check[](0), block.timestamp);
        }
    }
}

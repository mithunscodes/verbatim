// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {VerbatimVault} from "../src/VerbatimVault.sol";
import {TestToken} from "./TestToken.sol";
import {LeakyVault} from "./LeakyVault.sol";

contract AllowancesTest is Test {
    address constant ETH = address(0);

    VerbatimVault vault;
    TestToken usdc;
    address everydayKey = makeAddr("everydayKey");
    address rulesKey = makeAddr("rulesKey");
    address warmWallet = makeAddr("warmWallet");
    address mom = makeAddr("mom");
    address stranger = makeAddr("stranger");

    event AllowanceValiditySet(uint256 duration);
    event AllowanceCreated(address indexed contact, address indexed token, uint256 amount, uint256 activeFrom, uint256 expiresAt);
    event AllowanceUsed(address indexed contact, address indexed token, uint256 amount);

    function setUp() public {
        usdc = new TestToken();
        vault = new VerbatimVault(everydayKey, rulesKey, list(address(usdc)), new address[](0));
        usdc.mint(address(vault), 1000e6);
        vm.deal(address(vault), 1 ether);
        vm.startPrank(rulesKey);
        vault.saveContact(warmWallet);
        vault.saveContact(mom);
        vault.setDailyLimit(address(usdc), 10e6);
        vault.setDailyLimit(ETH, 0.1 ether);
        vm.stopPrank();
        vm.warp(block.timestamp + 7 days);
    }

    function list(address item) internal pure returns (address[] memory items) {
        items = new address[](1);
        items[0] = item;
    }

    function createAllowance(address contact, address token, uint256 amount) internal {
        vm.prank(rulesKey);
        vault.createAllowance(contact, token, amount);
    }

    function payWithAllowance(address contact, uint256 amount) internal {
        vm.prank(everydayKey);
        vault.payWithAllowance(contact, amount);
    }

    function test_AllowancePaysOnceAboveTheDailyLimit() public {
        vm.expectEmit(address(vault));
        emit AllowanceCreated(warmWallet, address(usdc), 600e6, block.timestamp, block.timestamp + 48 hours);
        createAllowance(warmWallet, address(usdc), 600e6);
        vm.expectEmit(address(vault));
        emit AllowanceUsed(warmWallet, address(usdc), 600e6);
        payWithAllowance(warmWallet, 600e6);
        assertEq(usdc.balanceOf(warmWallet), 600e6);
        assertEq(usdc.balanceOf(address(vault)), 400e6);
        assertEq(vault.leftToday(address(usdc)), 10e6);
        vm.expectRevert("Allowance already used");
        payWithAllowance(warmWallet, 600e6);
        assertEq(usdc.balanceOf(warmWallet), 600e6);
    }

    function test_AllowancePaysUpToItsAmountJustOnce() public {
        createAllowance(warmWallet, address(usdc), 600e6);
        vm.expectRevert("More than the allowance");
        payWithAllowance(warmWallet, 600e6 + 1);
        payWithAllowance(warmWallet, 250e6);
        vm.expectRevert("Allowance already used");
        payWithAllowance(warmWallet, 1);
        assertEq(usdc.balanceOf(warmWallet), 250e6);
    }

    function test_AllowanceIsOnlyForItsContact() public {
        createAllowance(warmWallet, address(usdc), 600e6);
        vm.expectRevert("No allowance for this contact");
        payWithAllowance(mom, 600e6);
        vm.expectRevert("No allowance for this contact");
        payWithAllowance(stranger, 600e6);
        assertEq(usdc.balanceOf(address(vault)), 1000e6);
    }

    function test_AllowanceLastsExactly48Hours() public {
        uint256 created = block.timestamp;
        createAllowance(warmWallet, address(usdc), 600e6);
        vm.warp(created + 48 hours + 1);
        vm.expectRevert("Allowance expired");
        payWithAllowance(warmWallet, 600e6);
        uint256 createdAgain = block.timestamp;
        createAllowance(warmWallet, address(usdc), 600e6);
        vm.warp(createdAgain + 48 hours);
        payWithAllowance(warmWallet, 600e6);
        assertEq(usdc.balanceOf(warmWallet), 600e6);
    }

    function test_AllowanceNotActiveYet() public {
        LeakyVault leaky = new LeakyVault(everydayKey, rulesKey, list(address(usdc)));
        usdc.mint(address(leaky), 100e6);
        vm.prank(rulesKey);
        leaky.saveContact(warmWallet);
        leaky.giveAllowance(
            warmWallet, VerbatimVault.Allowance(address(usdc), 50e6, block.timestamp + 8 days, block.timestamp + 10 days, false)
        );
        vm.prank(everydayKey);
        vm.expectRevert("Allowance not active yet");
        leaky.payWithAllowance(warmWallet, 50e6);
        vm.warp(block.timestamp + 8 days);
        vm.prank(everydayKey);
        leaky.payWithAllowance(warmWallet, 50e6);
        assertEq(usdc.balanceOf(warmWallet), 50e6);
    }

    function test_EthAllowance() public {
        createAllowance(warmWallet, ETH, 0.5 ether);
        payWithAllowance(warmWallet, 0.5 ether);
        assertEq(warmWallet.balance, 0.5 ether);
        assertEq(address(vault).balance, 0.5 ether);
        assertEq(vault.leftToday(ETH), 0.1 ether);
    }

    function test_OnlyTheRulesKeyCreatesAllowances() public {
        vm.prank(everydayKey);
        vm.expectRevert("Only the rules key can create allowances");
        vault.createAllowance(warmWallet, address(usdc), 600e6);
        vm.prank(stranger);
        vm.expectRevert("Only the rules key can create allowances");
        vault.createAllowance(stranger, address(usdc), 600e6);
    }

    function test_AllowancesOnlyForSavedContacts() public {
        vm.prank(rulesKey);
        vm.expectRevert("Not a saved contact");
        vault.createAllowance(stranger, address(usdc), 600e6);
    }

    function test_RevertWhen_AllowanceEmptyOrTokenNotWatched() public {
        TestToken unwatched = new TestToken();
        vm.startPrank(rulesKey);
        vm.expectRevert("An allowance can't be empty");
        vault.createAllowance(warmWallet, address(usdc), 0);
        vm.expectRevert("Not a watched token");
        vault.createAllowance(warmWallet, address(unwatched), 600e6);
        vm.stopPrank();
    }

    function test_OnlyTheEverydayKeyPays() public {
        createAllowance(warmWallet, address(usdc), 600e6);
        vm.prank(rulesKey);
        vm.expectRevert("Only the everyday key can pay");
        vault.payWithAllowance(warmWallet, 600e6);
        vm.prank(warmWallet);
        vm.expectRevert("Only the everyday key can pay");
        vault.payWithAllowance(warmWallet, 600e6);
        assertEq(usdc.balanceOf(warmWallet), 0);
    }

    function test_ValidityIsASetting() public {
        vm.prank(everydayKey);
        vm.expectRevert("Only the rules key can change settings");
        vault.setAllowanceValidity(30 days);
        vm.expectEmit(address(vault));
        emit AllowanceValiditySet(10 minutes);
        vm.prank(rulesKey);
        vault.setAllowanceValidity(10 minutes);
        assertEq(vault.allowanceValidity(), 10 minutes);
        uint256 created = block.timestamp;
        createAllowance(warmWallet, address(usdc), 600e6);
        vm.warp(created + 10 minutes + 1);
        vm.expectRevert("Allowance expired");
        payWithAllowance(warmWallet, 600e6);
    }

    function test_ChangingTheSettingDoesntStretchAnExistingAllowance() public {
        uint256 created = block.timestamp;
        createAllowance(warmWallet, address(usdc), 600e6);
        vm.prank(rulesKey);
        vault.setAllowanceValidity(30 days);
        vm.warp(created + 48 hours + 1);
        vm.expectRevert("Allowance expired");
        payWithAllowance(warmWallet, 600e6);
    }

    function test_AllowancesAndSettingsCantChangeDuringARun() public {
        LeakyVault leaky = new LeakyVault(everydayKey, rulesKey, list(address(usdc)));
        vm.prank(rulesKey);
        leaky.saveContact(warmWallet);
        VerbatimVault.Allowance memory planted =
            VerbatimVault.Allowance(address(usdc), 1000e6, block.timestamp, block.timestamp + 48 hours, false);
        VerbatimVault.Action[] memory actions = new VerbatimVault.Action[](1);
        actions[0] =
            VerbatimVault.Action(address(leaky), 0, abi.encodeCall(LeakyVault.giveAllowance, (warmWallet, planted)), 0);
        vm.prank(everydayKey);
        vm.expectRevert("Your account would change");
        leaky.run(actions, new VerbatimVault.Check[](0), block.timestamp);
        actions[0] = VerbatimVault.Action(address(leaky), 0, abi.encodeCall(LeakyVault.setValidity, (365 days)), 0);
        vm.prank(everydayKey);
        vm.expectRevert("Your account would change");
        leaky.run(actions, new VerbatimVault.Check[](0), block.timestamp);
    }
}

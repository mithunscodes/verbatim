// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {VerbatimVault, IPermit2} from "../src/VerbatimVault.sol";
import {TestDirectory} from "./TestDirectory.sol";
import {TestToken} from "./TestToken.sol";
import {TestRouter} from "./TestRouter.sol";
import {TestPriceSource} from "./TestPriceSource.sol";
import {LeakyVault} from "./LeakyVault.sol";

contract NewContactsTest is Test {
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant ETH = address(0);

    VerbatimVault vault;
    TestToken usdc;
    TestRouter router;
    TestPriceSource prices;
    address everydayKey = makeAddr("everydayKey");
    address rulesKey = makeAddr("rulesKey");
    address mom = makeAddr("mom");
    address vendor = makeAddr("vendor");

    event ContactSaved(address indexed contact);
    event NewContactLimitSet(address indexed token, uint256 amount);
    event NewContactPeriodSet(uint256 duration);
    event AllowanceMinAgeSet(uint256 duration);

    function setUp() public {
        vm.etch(PERMIT2, vm.parseJsonBytes(vm.readFile("test/fixtures/permit2-sepolia.json"), ".code"));
        usdc = new TestToken();
        router = new TestRouter();
        vault = new VerbatimVault(everydayKey, rulesKey, list(address(usdc)), address(new TestDirectory(list(address(router)))));
        usdc.mint(address(vault), 2000e6);
        vm.deal(address(vault), 1 ether);
        vm.deal(address(router), 10 ether);
        prices = new TestPriceSource();
        prices.setPrice(address(usdc), 1e6, 1e6);
        prices.setPrice(address(0), 1 ether, 50_000e6);
        vm.startPrank(rulesKey);
        vault.saveContact(mom);
        vault.setDailyLimit(address(usdc), 1000e6);
        vault.setDailyLimit(ETH, 1 ether);
        vault.setNewContactLimit(address(usdc), 50e6);
        vault.setNewContactLimit(ETH, 0.02 ether);
        vault.setPriceSource(address(prices));
        vault.finishSetup();
        vm.stopPrank();
        vm.warp(vm.getBlockTimestamp() + 30 days);
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

    function swapTo(address recipient, uint256 amountIn, uint256 ethOut)
        internal
        view
        returns (VerbatimVault.Action[] memory actions)
    {
        actions = new VerbatimVault.Action[](3);
        actions[0] = VerbatimVault.Action(address(usdc), 0, abi.encodeCall(TestToken.approve, (PERMIT2, amountIn)), 0);
        actions[1] = VerbatimVault.Action(
            PERMIT2,
            0,
            abi.encodeCall(IPermit2.approve, (address(usdc), address(router), uint160(amountIn), uint48(vm.getBlockTimestamp()))),
            0
        );
        actions[2] = VerbatimVault.Action(
            address(router), 0, abi.encodeCall(TestRouter.swapTo, (address(usdc), uint160(amountIn), ethOut, recipient)), 0
        );
    }

    function saveVendor() internal returns (uint256 savedTime) {
        vm.prank(rulesKey);
        vault.saveContact(vendor);
        return vm.getBlockTimestamp();
    }

    function pay(address to, uint256 amount) internal {
        vm.prank(everydayKey);
        vault.run(only(sendUsdc(to, amount)), atMost(address(usdc), amount), vm.getBlockTimestamp());
    }

    function payEth(address to, uint256 amount) internal {
        vm.prank(everydayKey);
        vault.run(only(VerbatimVault.Action(to, amount, "", 0)), atMost(ETH, amount), vm.getBlockTimestamp());
    }

    function proposeAllowance(address contact, uint256 amount) internal returns (uint256 id) {
        vm.prank(everydayKey);
        id = vault.propose(VerbatimVault.ChangeKind.Allowance, contact, address(usdc), amount);
    }

    function test_AddingAContactNeedsThePhone() public {
        vm.prank(everydayKey);
        vm.expectRevert("Only the rules key can save contacts");
        vault.saveContact(vendor);
        vm.expectEmit(address(vault));
        emit ContactSaved(vendor);
        vm.prank(rulesKey);
        vault.saveContact(vendor);
        assertEq(vault.savedAt(vendor), vm.getBlockTimestamp());
    }

    function test_NewContactCanBePaidAtOnce() public {
        saveVendor();
        pay(vendor, 50e6);
        assertEq(usdc.balanceOf(vendor), 50e6);
    }

    function test_FiftyUsdcIsATotalAcrossSmallSends() public {
        saveVendor();
        pay(vendor, 20e6);
        pay(vendor, 20e6);
        pay(vendor, 10e6);
        vm.expectRevert("Over the new-contact limit");
        pay(vendor, 1);
        assertEq(usdc.balanceOf(vendor), 50e6);
    }

    function test_SendsInOneRunCountTogether() public {
        saveVendor();
        VerbatimVault.Action[] memory actions = new VerbatimVault.Action[](2);
        actions[0] = sendUsdc(vendor, 30e6);
        actions[1] = sendUsdc(vendor, 30e6);
        vm.prank(everydayKey);
        vm.expectRevert("Over the new-contact limit");
        vault.run(actions, atMost(address(usdc), 60e6), vm.getBlockTimestamp());
        assertEq(usdc.balanceOf(vendor), 0);
    }

    function test_BecomesANormalContactAfter24Hours() public {
        uint256 saved = saveVendor();
        pay(vendor, 50e6);
        vm.warp(saved + 24 hours - 1);
        vm.expectRevert("Over the new-contact limit");
        pay(vendor, 1);
        vm.warp(saved + 24 hours);
        pay(vendor, 500e6);
        assertEq(usdc.balanceOf(vendor), 550e6);
    }

    function test_SwapOutputSentToANewContactCounts() public {
        saveVendor();
        vm.prank(everydayKey);
        vm.expectRevert("Over the new-contact limit");
        vault.run(swapTo(vendor, 5e6, 0.03 ether), atMost(address(usdc), 5e6), vm.getBlockTimestamp());
        vm.prank(everydayKey);
        vm.expectRevert("Unfair trade");
        vault.run(swapTo(vendor, 5e6, 0.02 ether), atMost(address(usdc), 5e6), vm.getBlockTimestamp());
        assertEq(vendor.balance, 0);
    }

    function test_EthToANewContactHasItsOwnLimit() public {
        saveVendor();
        payEth(vendor, 0.02 ether);
        vm.expectRevert("Over the new-contact limit");
        payEth(vendor, 1);
        pay(vendor, 50e6);
        assertEq(vendor.balance, 0.02 ether);
        assertEq(usdc.balanceOf(vendor), 50e6);
    }

    function test_NoNewContactLimitSetMeansNothingForNewContacts() public {
        vault = new VerbatimVault(everydayKey, rulesKey, list(address(usdc)), address(new TestDirectory(list(address(router)))));
        usdc.mint(address(vault), 100e6);
        vm.startPrank(rulesKey);
        vault.setDailyLimit(address(usdc), 100e6);
        vault.saveContact(vendor);
        vault.finishSetup();
        vm.stopPrank();
        assertEq(vault.newContactLimit(address(usdc)), 0);
        vm.expectRevert("Over the new-contact limit");
        pay(vendor, 1);
        assertEq(usdc.balanceOf(address(vault)), 100e6);
    }

    function test_EstablishedContactsArentLimited() public {
        saveVendor();
        pay(mom, 500e6);
        assertEq(usdc.balanceOf(mom), 500e6);
    }

    function test_AllowanceToAn8DayOldContactWorks() public {
        saveVendor();
        vm.warp(vm.getBlockTimestamp() + 8 days);
        uint256 id = proposeAllowance(vendor, 600e6);
        vm.prank(rulesKey);
        vault.approve(id);
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        vm.prank(everydayKey);
        vault.payWithAllowance(vendor, 600e6);
        assertEq(usdc.balanceOf(vendor), 600e6);
    }

    function test_AllowanceToA3DayOldContactFails() public {
        saveVendor();
        vm.warp(vm.getBlockTimestamp() + 3 days);
        uint256 id = proposeAllowance(vendor, 600e6);
        vm.prank(rulesKey);
        vm.expectRevert("Contact too new for big payments");
        vault.approve(id);
    }

    function test_AllowancesStartAtExactly7Days() public {
        uint256 saved = saveVendor();
        uint256 id = proposeAllowance(vendor, 600e6);
        vm.warp(saved + 7 days - 1);
        vm.prank(rulesKey);
        vm.expectRevert("Contact too new for big payments");
        vault.approve(id);
        vm.warp(saved + 7 days);
        vm.prank(rulesKey);
        vault.approve(id);
    }

    function test_PayingChecksTheAgeToo() public {
        LeakyVault leaky = new LeakyVault(everydayKey, rulesKey, list(address(usdc)));
        usdc.mint(address(leaky), 1000e6);
        vm.startPrank(rulesKey);
        leaky.saveContact(vendor);
        leaky.finishSetup();
        vm.stopPrank();
        vm.warp(vm.getBlockTimestamp() + 3 days);
        leaky.giveAllowance(
            vendor, VerbatimVault.Allowance(address(usdc), 600e6, vm.getBlockTimestamp(), vm.getBlockTimestamp() + 2 days, false)
        );
        vm.prank(everydayKey);
        vm.expectRevert("Contact too new for big payments");
        leaky.payWithAllowance(vendor, 600e6);
        assertEq(usdc.balanceOf(vendor), 0);
    }

    function test_NewContactRulesAreSettings() public {
        vault = new VerbatimVault(everydayKey, rulesKey, list(address(usdc)), address(new TestDirectory(list(address(router)))));
        usdc.mint(address(vault), 2000e6);
        vm.startPrank(everydayKey);
        vm.expectRevert("Only the rules key can change settings");
        vault.setNewContactPeriod(0);
        vm.expectRevert("Only the rules key can change settings");
        vault.setAllowanceMinAge(0);
        vm.expectRevert("Only the rules key can set limits");
        vault.setNewContactLimit(address(usdc), 1000e6);
        vm.stopPrank();
        vm.startPrank(rulesKey);
        vm.expectEmit(address(vault));
        emit NewContactPeriodSet(10 minutes);
        vault.setNewContactPeriod(10 minutes);
        vm.expectEmit(address(vault));
        emit AllowanceMinAgeSet(1 hours);
        vault.setAllowanceMinAge(1 hours);
        vm.expectEmit(address(vault));
        emit NewContactLimitSet(address(usdc), 20e6);
        vault.setNewContactLimit(address(usdc), 20e6);
        vault.setDailyLimit(address(usdc), 1000e6);
        vault.setLooseningWait(0);
        vault.finishSetup();
        vm.stopPrank();
        uint256 saved = saveVendor();
        vm.expectRevert("Over the new-contact limit");
        pay(vendor, 21e6);
        vm.warp(saved + 10 minutes);
        pay(vendor, 21e6);
        vm.warp(saved + 1 hours);
        uint256 id = proposeAllowance(vendor, 600e6);
        vm.prank(rulesKey);
        vault.approve(id);
        vm.prank(everydayKey);
        vault.payWithAllowance(vendor, 600e6);
        assertEq(vault.newContactPeriod(), 10 minutes);
        assertEq(vault.allowanceMinAge(), 1 hours);
        assertEq(usdc.balanceOf(vendor), 621e6);
    }

    function test_NewContactRulesCantChangeDuringARun() public {
        LeakyVault leaky = new LeakyVault(everydayKey, rulesKey, list(address(usdc)));
        vm.startPrank(rulesKey);
        leaky.saveContact(vendor);
        leaky.finishSetup();
        vm.stopPrank();
        bytes[4] memory sneaky = [
            abi.encodeCall(LeakyVault.backdateContact, (vendor, 0)),
            abi.encodeCall(LeakyVault.raiseNewContactLimit, (1, 1000e6)),
            abi.encodeCall(LeakyVault.shortenNewContactPeriod, (0)),
            abi.encodeCall(LeakyVault.shortenAllowanceMinAge, (0))
        ];
        for (uint256 i = 0; i < sneaky.length; i++) {
            VerbatimVault.Action[] memory actions = only(VerbatimVault.Action(address(leaky), 0, sneaky[i], 0));
            vm.prank(everydayKey);
            vm.expectRevert("Your account would change");
            leaky.run(actions, new VerbatimVault.Check[](0), vm.getBlockTimestamp());
        }
    }
}

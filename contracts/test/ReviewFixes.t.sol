// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {VerbatimVault, IPermit2} from "../src/VerbatimVault.sol";
import {TestDirectory} from "./TestDirectory.sol";
import {TestToken} from "./TestToken.sol";
import {TestRouter} from "./TestRouter.sol";
import {TestPriceSource} from "./TestPriceSource.sol";

contract PassesItOn {
    TestToken immutable usdc;
    address immutable onward;

    constructor(TestToken usdc_, address onward_) {
        usdc = usdc_;
        onward = onward_;
    }

    receive() external payable {
        uint256 held = usdc.balanceOf(address(this));
        if (held > 0) usdc.transfer(onward, held);
    }
}

contract SendsItBack {
    receive() external payable {
        (bool ok,) = msg.sender.call{value: msg.value}("");
        require(ok, "Couldn't send it back");
    }
}

contract SendsTokensBack {
    TestToken immutable usdc;

    constructor(TestToken usdc_) {
        usdc = usdc_;
    }

    receive() external payable {
        uint256 held = usdc.balanceOf(address(this));
        if (held > 0) usdc.transfer(msg.sender, held);
    }
}

contract ReviewFixesTest is Test {
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant ETH = address(0);

    VerbatimVault vault;
    TestDirectory directory;
    TestToken usdc;
    TestRouter router;
    TestPriceSource prices;
    address everydayKey = makeAddr("everydayKey");
    address rulesKey = makeAddr("rulesKey");
    address mom = makeAddr("mom");
    address thief = makeAddr("thief");

    function setUp() public {
        vm.etch(PERMIT2, vm.parseJsonBytes(vm.readFile("test/fixtures/permit2-sepolia.json"), ".code"));
        usdc = new TestToken();
        router = new TestRouter();
        address[] memory trusted = new address[](1);
        trusted[0] = address(router);
        address[] memory watched = new address[](1);
        watched[0] = address(usdc);
        directory = new TestDirectory(trusted);
        vault = new VerbatimVault(everydayKey, rulesKey, watched, address(directory));
        usdc.mint(address(vault), 2000e6);
        vm.deal(address(vault), 1 ether);
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

    function atMost(address token, uint256 amount) internal pure returns (VerbatimVault.Check[] memory checks) {
        checks = new VerbatimVault.Check[](1);
        checks[0] = VerbatimVault.Check(VerbatimVault.CheckKind.AtMostLeaves, token, address(0), amount);
    }

    function sendUsdc(address to, uint256 amount) internal view returns (VerbatimVault.Action memory) {
        return VerbatimVault.Action(address(usdc), 0, abi.encodeCall(TestToken.transfer, (to, amount)), 0);
    }

    function poke(address contact, uint256 value) internal pure returns (VerbatimVault.Action memory) {
        return VerbatimVault.Action(contact, value, "", 0);
    }

    function save(address contact) internal {
        vm.prank(rulesKey);
        vault.saveContact(contact);
    }

    function routerPaysThief(VerbatimVault.Action[] memory actions, uint256 from, uint256 amount) internal view {
        actions[from] = VerbatimVault.Action(address(usdc), 0, abi.encodeCall(TestToken.approve, (PERMIT2, amount)), 0);
        actions[from + 1] = VerbatimVault.Action(
            PERMIT2,
            0,
            abi.encodeCall(IPermit2.approve, (address(usdc), address(router), uint160(amount), uint48(vm.getBlockTimestamp()))),
            0
        );
        actions[from + 2] =
            VerbatimVault.Action(address(router), 0, abi.encodeCall(TestRouter.sendTo, (address(usdc), uint160(amount), thief)), 0);
    }

    function run(VerbatimVault.Action[] memory actions, VerbatimVault.Check[] memory checks) internal {
        vm.prank(everydayKey);
        vault.run(actions, checks, vm.getBlockTimestamp());
    }

    function proposeLimit(uint256 amount) internal returns (uint256 id) {
        vm.prank(everydayKey);
        id = vault.propose(VerbatimVault.ChangeKind.DailyLimit, address(0), address(usdc), amount);
    }

    function test_NewContactPassingMoneyOnIsStillCounted() public {
        PassesItOn fresh = new PassesItOn(usdc, thief);
        save(address(fresh));
        VerbatimVault.Action[] memory actions = new VerbatimVault.Action[](2);
        actions[0] = sendUsdc(address(fresh), 900e6);
        actions[1] = poke(address(fresh), 0);
        vm.expectRevert("Over the new-contact limit");
        run(actions, atMost(address(usdc), 900e6));
        assertEq(usdc.balanceOf(thief), 0);
    }

    function test_NewContactLimitIsATotalEvenWhenPassedOn() public {
        PassesItOn fresh = new PassesItOn(usdc, thief);
        save(address(fresh));
        VerbatimVault.Action[] memory actions = new VerbatimVault.Action[](2);
        actions[0] = sendUsdc(address(fresh), 50e6);
        actions[1] = poke(address(fresh), 0);
        run(actions, atMost(address(usdc), 50e6));
        assertEq(usdc.balanceOf(address(fresh)), 0);
        actions[0] = sendUsdc(address(fresh), 1);
        vm.expectRevert("Over the new-contact limit");
        run(actions, atMost(address(usdc), 1));
        assertEq(usdc.balanceOf(thief), 50e6);
    }

    function test_PlainNewContactLimitStillHolds() public {
        address fresh = makeAddr("fresh");
        save(fresh);
        VerbatimVault.Action[] memory actions = new VerbatimVault.Action[](1);
        actions[0] = sendUsdc(fresh, 900e6);
        vm.expectRevert("Over the new-contact limit");
        run(actions, atMost(address(usdc), 900e6));
    }

    function test_VaultCantBeItsOwnContact() public {
        vm.prank(rulesKey);
        vm.expectRevert("Your account can't be its own contact");
        vault.saveContact(address(vault));
    }

    function test_VaultCantBeSavedThroughItsOwnName() public {
        directory.setName("myvault.eth", address(vault));
        vm.prank(rulesKey);
        vm.expectRevert("Your account can't be its own contact");
        vault.saveContactName("myvault.eth");
    }

    function test_PayingYourselfIsRefused() public {
        VerbatimVault.Action[] memory actions = new VerbatimVault.Action[](4);
        actions[0] = poke(address(vault), 0.5 ether);
        routerPaysThief(actions, 1, 1000e6);
        vm.expectRevert("Not a saved contact");
        run(actions, atMost(address(usdc), 1000e6));
        assertEq(usdc.balanceOf(thief), 0);
    }

    function test_DrainWithoutAFakePaymentIsUnfair() public {
        VerbatimVault.Action[] memory actions = new VerbatimVault.Action[](3);
        routerPaysThief(actions, 0, 1000e6);
        vm.expectRevert("Unfair trade");
        run(actions, atMost(address(usdc), 1000e6));
    }

    function test_EthSentBackByANewContactIsntTradeValue() public {
        SendsItBack fresh = new SendsItBack();
        save(address(fresh));
        VerbatimVault.Action[] memory actions = new VerbatimVault.Action[](4);
        actions[0] = poke(address(fresh), 0.02 ether);
        routerPaysThief(actions, 1, 1000e6);
        vm.expectRevert("Unfair trade");
        run(actions, atMost(address(usdc), 1000e6));
        assertEq(usdc.balanceOf(thief), 0);
    }

    function test_EthSentBackByAnOldContactIsntTradeValue() public {
        SendsItBack old = new SendsItBack();
        save(address(old));
        vm.warp(vm.getBlockTimestamp() + 2 days);
        VerbatimVault.Action[] memory actions = new VerbatimVault.Action[](4);
        actions[0] = poke(address(old), 0.5 ether);
        routerPaysThief(actions, 1, 1000e6);
        vm.expectRevert("Unfair trade");
        run(actions, atMost(address(usdc), 1000e6));
        assertEq(usdc.balanceOf(thief), 0);
    }

    function test_TokensSentBackByAContactArentTradeValue() public {
        SendsTokensBack old = new SendsTokensBack(usdc);
        save(address(old));
        vm.warp(vm.getBlockTimestamp() + 2 days);
        VerbatimVault.Action[] memory actions = new VerbatimVault.Action[](5);
        actions[0] = sendUsdc(address(old), 500e6);
        actions[1] = poke(address(old), 0);
        routerPaysThief(actions, 2, 500e6);
        vm.expectRevert("Unfair trade");
        run(actions, atMost(address(usdc), 500e6));
        assertEq(usdc.balanceOf(thief), 0);
    }

    function test_PaymentsBesideAFairSwapStillPass() public {
        vm.deal(address(router), 1 ether);
        VerbatimVault.Action[] memory actions = new VerbatimVault.Action[](4);
        actions[0] = VerbatimVault.Action(address(usdc), 0, abi.encodeCall(TestToken.approve, (PERMIT2, 100e6)), 0);
        actions[1] = VerbatimVault.Action(
            PERMIT2,
            0,
            abi.encodeCall(IPermit2.approve, (address(usdc), address(router), uint160(100e6), uint48(vm.getBlockTimestamp()))),
            0
        );
        actions[2] = VerbatimVault.Action(
            address(router), 0, abi.encodeCall(TestRouter.swapTo, (address(usdc), uint160(100e6), 0.002 ether, address(vault))), 0
        );
        actions[3] = sendUsdc(mom, 400e6);
        run(actions, atMost(address(usdc), 500e6));
        assertEq(usdc.balanceOf(mom), 400e6);
        assertEq(address(vault).balance, 1.002 ether);
    }

    function test_FiveChangesCanWaitButNotSix() public {
        for (uint256 i = 0; i < 5; i++) {
            proposeLimit(2000e6 + i);
        }
        vm.prank(everydayKey);
        vm.expectRevert("Too many changes waiting for your phone");
        vault.propose(VerbatimVault.ChangeKind.DailyLimit, address(0), address(usdc), 9000e6);
        assertEq(vault.changeCount(), 5);
    }

    function test_ApprovingFreesASlot() public {
        for (uint256 i = 0; i < 5; i++) {
            proposeLimit(2000e6 + i);
        }
        vm.prank(rulesKey);
        vault.approve(0);
        proposeLimit(9000e6);
        vm.prank(everydayKey);
        vm.expectRevert("Too many changes waiting for your phone");
        vault.propose(VerbatimVault.ChangeKind.DailyLimit, address(0), address(usdc), 9001e6);
    }

    function test_CancellingFreesASlot() public {
        for (uint256 i = 0; i < 5; i++) {
            proposeLimit(2000e6 + i);
        }
        vm.prank(rulesKey);
        vault.cancel(3);
        proposeLimit(9000e6);
        assertEq(vault.changeCount(), 6);
    }

    function test_CancellingAnApprovedChangeFreesNothingMore() public {
        for (uint256 i = 0; i < 5; i++) {
            proposeLimit(2000e6 + i);
        }
        vm.startPrank(rulesKey);
        vault.approve(0);
        vault.cancel(0);
        vm.stopPrank();
        proposeLimit(9000e6);
        vm.prank(everydayKey);
        vm.expectRevert("Too many changes waiting for your phone");
        vault.propose(VerbatimVault.ChangeKind.DailyLimit, address(0), address(usdc), 9001e6);
    }
}

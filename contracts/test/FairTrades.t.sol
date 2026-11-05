// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {VerbatimVault, IPermit2} from "../src/VerbatimVault.sol";
import {TestDirectory} from "./TestDirectory.sol";
import {TestToken} from "./TestToken.sol";
import {TestRouter} from "./TestRouter.sol";
import {TestPriceSource} from "./TestPriceSource.sol";
import {LeakyVault} from "./LeakyVault.sol";

contract FairTradesTest is Test {
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant ETH = address(0);

    VerbatimVault vault;
    TestToken usdc;
    TestRouter router;
    TestPriceSource prices;
    address everydayKey = makeAddr("everydayKey");
    address rulesKey = makeAddr("rulesKey");
    address mom = makeAddr("mom");
    address stranger = makeAddr("stranger");

    event TradeToleranceSet(uint256 basisPoints);
    event PriceSourceSet(address source);

    function setUp() public {
        vm.etch(PERMIT2, vm.parseJsonBytes(vm.readFile("test/fixtures/permit2-sepolia.json"), ".code"));
        usdc = new TestToken();
        router = new TestRouter();
        prices = new TestPriceSource();
        prices.setPrice(address(usdc), 1e6, 1e6);
        prices.setPrice(ETH, 1 ether, 50_000e6);
        vault = newVault();
        vm.startPrank(rulesKey);
        vault.setPriceSource(address(prices));
        vault.finishSetup();
        vm.stopPrank();
        vm.warp(vm.getBlockTimestamp() + 1 days);
    }

    function newVault() internal returns (VerbatimVault fresh) {
        fresh = new VerbatimVault(everydayKey, rulesKey, list(address(usdc)), address(new TestDirectory(list(address(router)))));
        usdc.mint(address(fresh), 10_000e6);
        usdc.mint(address(router), 10_000e6);
        vm.deal(address(fresh), 1 ether);
        vm.deal(address(router), 10 ether);
        vm.startPrank(rulesKey);
        fresh.saveContact(mom);
        fresh.setDailyLimit(address(usdc), 1000e6);
        fresh.setDailyLimit(ETH, 1 ether);
        vm.stopPrank();
    }

    function list(address item) internal pure returns (address[] memory items) {
        items = new address[](1);
        items[0] = item;
    }

    function fairEth(uint256 usdcAmount) internal pure returns (uint256) {
        return usdcAmount * 1 ether / 50_000e6;
    }

    function act(address target, uint256 value, bytes memory data) internal pure returns (VerbatimVault.Action memory) {
        return VerbatimVault.Action(target, value, data, 0);
    }

    function swapActions(uint256 amountIn, uint256 ethOut, address recipient)
        internal
        view
        returns (VerbatimVault.Action[] memory actions)
    {
        actions = new VerbatimVault.Action[](3);
        actions[0] = act(address(usdc), 0, abi.encodeCall(TestToken.approve, (PERMIT2, amountIn)));
        actions[1] = act(
            PERMIT2,
            0,
            abi.encodeCall(IPermit2.approve, (address(usdc), address(router), uint160(amountIn), uint48(vm.getBlockTimestamp())))
        );
        actions[2] =
            act(address(router), 0, abi.encodeCall(TestRouter.swapTo, (address(usdc), uint160(amountIn), ethOut, recipient)));
    }

    function plus(VerbatimVault.Action[] memory actions, VerbatimVault.Action memory extra)
        internal
        pure
        returns (VerbatimVault.Action[] memory all)
    {
        all = new VerbatimVault.Action[](actions.length + 1);
        for (uint256 i = 0; i < actions.length; i++) {
            all[i] = actions[i];
        }
        all[actions.length] = extra;
    }

    function atMost(address token, uint256 amount) internal pure returns (VerbatimVault.Check[] memory checks) {
        checks = new VerbatimVault.Check[](1);
        checks[0] = VerbatimVault.Check(VerbatimVault.CheckKind.AtMostLeaves, token, address(0), amount);
    }

    function run(VerbatimVault target, VerbatimVault.Action[] memory actions, VerbatimVault.Check[] memory checks) internal {
        vm.prank(everydayKey);
        target.run(actions, checks, vm.getBlockTimestamp());
    }

    function swap(uint256 amountIn, uint256 ethOut) internal {
        run(vault, swapActions(amountIn, ethOut, address(vault)), atMost(address(usdc), amountIn));
    }

    function payMom(uint256 amount) internal view returns (VerbatimVault.Action memory) {
        return act(address(usdc), 0, abi.encodeCall(TestToken.transfer, (mom, amount)));
    }

    function test_FairSwapPasses() public {
        swap(100e6, fairEth(100e6));
        assertEq(address(vault).balance, 1 ether + 0.002 ether);
        assertEq(usdc.balanceOf(address(vault)), 9_900e6);
    }

    function test_SwapAtTheToleranceStillPasses() public {
        swap(100e6, fairEth(100e6) * 9700 / 10_000);
        assertEq(address(vault).balance, 1 ether + 0.00194 ether);
    }

    function test_SwapJustPastTheToleranceFails() public {
        uint256 ethOut = fairEth(100e6) * 9699 / 10_000;
        vm.expectRevert("Unfair trade");
        swap(100e6, ethOut);
    }

    function test_TerribleSwapFails() public {
        uint256 ethOut = fairEth(100e6) / 100;
        vm.expectRevert("Unfair trade");
        swap(100e6, ethOut);
        assertEq(usdc.balanceOf(address(vault)), 10_000e6);
    }

    function test_SwapOutputSentElsewhereFails() public {
        VerbatimVault.Action[] memory actions = swapActions(100e6, fairEth(100e6), stranger);
        vm.expectRevert("Unfair trade");
        run(vault, actions, atMost(address(usdc), 100e6));
        assertEq(stranger.balance, 0);
    }

    function test_RouterPayingSomeoneDirectlyFails() public {
        VerbatimVault.Action[] memory actions = new VerbatimVault.Action[](3);
        actions[0] = act(address(usdc), 0, abi.encodeCall(TestToken.approve, (PERMIT2, 100e6)));
        actions[1] = act(
            PERMIT2, 0, abi.encodeCall(IPermit2.approve, (address(usdc), address(router), uint160(100e6), uint48(vm.getBlockTimestamp())))
        );
        actions[2] = act(address(router), 0, abi.encodeCall(TestRouter.sendTo, (address(usdc), uint160(100e6), stranger)));
        vm.expectRevert("Unfair trade");
        run(vault, actions, atMost(address(usdc), 100e6));
        assertEq(usdc.balanceOf(stranger), 0);
    }

    function test_PaymentsArentTrades() public {
        run(vault, plus(swapActions(100e6, fairEth(100e6), address(vault)), payMom(50e6)), atMost(address(usdc), 150e6));
        assertEq(usdc.balanceOf(mom), 50e6);
        assertEq(address(vault).balance, 1 ether + 0.002 ether);
    }

    function test_PaymentsCantHideAnUnfairSwap() public {
        VerbatimVault.Action[] memory actions =
            plus(swapActions(100e6, fairEth(100e6) / 2, address(vault)), payMom(50e6));
        vm.expectRevert("Unfair trade");
        run(vault, actions, atMost(address(usdc), 150e6));
        assertEq(usdc.balanceOf(mom), 0);
    }

    function test_EthOutIsCheckedToo() public {
        VerbatimVault.Action[] memory fair = new VerbatimVault.Action[](1);
        fair[0] = act(address(router), 0.002 ether, abi.encodeCall(TestRouter.sell, (address(usdc), 100e6)));
        run(vault, fair, atMost(ETH, 0.002 ether));
        assertEq(usdc.balanceOf(address(vault)), 10_100e6);
        VerbatimVault.Action[] memory unfair = new VerbatimVault.Action[](1);
        unfair[0] = act(address(router), 0.002 ether, abi.encodeCall(TestRouter.sell, (address(usdc), 10e6)));
        vm.expectRevert("Unfair trade");
        run(vault, unfair, atMost(ETH, 0.002 ether));
    }

    function test_NoPriceSourceMeansNoTrades() public {
        VerbatimVault fresh = newVault();
        vm.prank(rulesKey);
        fresh.finishSetup();
        vm.warp(vm.getBlockTimestamp() + 1 days);
        VerbatimVault.Action[] memory actions = swapActions(100e6, fairEth(100e6), address(fresh));
        vm.expectRevert("No fair price available");
        run(fresh, actions, atMost(address(usdc), 100e6));
        VerbatimVault.Action[] memory payment = new VerbatimVault.Action[](1);
        payment[0] = payMom(50e6);
        run(fresh, payment, atMost(address(usdc), 50e6));
        assertEq(usdc.balanceOf(mom), 50e6);
    }

    function test_PhoneTightensTheToleranceAtOnce() public {
        vm.expectEmit(address(vault));
        emit TradeToleranceSet(100);
        vm.prank(rulesKey);
        vault.setTradeTolerance(100);
        uint256 ethOut = fairEth(100e6) * 98 / 100;
        vm.expectRevert("Unfair trade");
        swap(100e6, ethOut);
        swap(100e6, fairEth(100e6) * 99 / 100);
    }

    function test_LooseningTheToleranceNeedsAProposal() public {
        vm.prank(rulesKey);
        vm.expectRevert("Loosening needs a proposal");
        vault.setTradeTolerance(500);
        vm.prank(everydayKey);
        uint256 id = vault.propose(VerbatimVault.ChangeKind.TradeTolerance, address(0), address(0), 500);
        vm.prank(rulesKey);
        vault.approve(id);
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        vault.switchOn(id);
        assertEq(vault.tradeTolerance(), 500);
        swap(100e6, fairEth(100e6) * 96 / 100);
    }

    function test_ToleranceCantBeOver100Percent() public {
        VerbatimVault fresh = newVault();
        vm.prank(rulesKey);
        vm.expectRevert("Tolerance can't be over 100%");
        fresh.setTradeTolerance(10_001);
    }

    function test_ChangingThePriceSourceNeedsAProposal() public {
        TestPriceSource other = new TestPriceSource();
        vm.prank(rulesKey);
        vm.expectRevert("Loosening needs a proposal");
        vault.setPriceSource(address(other));
        vm.prank(everydayKey);
        uint256 id = vault.propose(VerbatimVault.ChangeKind.PriceSource, address(0), address(0), uint256(uint160(address(other))));
        vm.prank(rulesKey);
        vault.approve(id);
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        vm.expectEmit(address(vault));
        emit PriceSourceSet(address(other));
        vault.switchOn(id);
        assertEq(vault.priceSource(), address(other));
    }

    function test_PriceSourceProposalMustBeAnAddress() public {
        vm.prank(everydayKey);
        uint256 id = vault.propose(VerbatimVault.ChangeKind.PriceSource, address(0), address(0), uint256(type(uint160).max) + 1);
        vm.prank(rulesKey);
        vault.approve(id);
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        vm.expectRevert("Not an address");
        vault.switchOn(id);
    }

    function test_TokensAndTrustedContractsCantBeContacts() public {
        VerbatimVault fresh = new VerbatimVault(everydayKey, rulesKey, list(address(usdc)), address(new TestDirectory(list(address(router)))));
        vm.startPrank(rulesKey);
        vm.expectRevert("A token or trusted contract can't be a contact");
        fresh.saveContact(address(router));
        vm.expectRevert("A token or trusted contract can't be a contact");
        fresh.saveContact(address(usdc));
        vm.expectRevert("A token or trusted contract can't be a contact");
        fresh.saveContact(PERMIT2);
        vm.stopPrank();
    }

    function test_PriceRulesCantChangeDuringARun() public {
        LeakyVault leaky = new LeakyVault(everydayKey, rulesKey, list(address(usdc)));
        vm.prank(rulesKey);
        leaky.finishSetup();
        bytes[2] memory sneaky = [
            abi.encodeCall(LeakyVault.raiseTolerance, (10_000)),
            abi.encodeCall(LeakyVault.swapPriceSource, (stranger))
        ];
        for (uint256 i = 0; i < sneaky.length; i++) {
            VerbatimVault.Action[] memory actions = new VerbatimVault.Action[](1);
            actions[0] = act(address(leaky), 0, sneaky[i]);
            vm.prank(everydayKey);
            vm.expectRevert("Your account would change");
            leaky.run(actions, new VerbatimVault.Check[](0), vm.getBlockTimestamp());
        }
    }

    function test_SkimIsCappedByTheDailyLimit() public {
        swap(1000e6, fairEth(1000e6) * 9700 / 10_000);
        assertEq(vault.leftToday(address(usdc)), 0);
        uint256 ethOut = fairEth(1e6);
        vm.expectRevert("Over the daily limit");
        swap(1e6, ethOut);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {VerbatimVault, IPermit2} from "../src/VerbatimVault.sol";
import {VerbatimPrints} from "../experiments/VerbatimPrints.sol";
import {TestDirectory} from "./TestDirectory.sol";
import {TestToken} from "./TestToken.sol";
import {TestRouter} from "./TestRouter.sol";
import {TestPriceSource} from "./TestPriceSource.sol";

contract MintTest is Test {
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant ETH = address(0);
    uint256 constant PRICE = 0.0001 ether;
    bytes32 constant ROOT = keccak256("picture");

    VerbatimVault vault;
    VerbatimPrints prints;
    TestToken usdc;
    TestRouter router;
    TestPriceSource prices;
    address everydayKey = makeAddr("everydayKey");
    address rulesKey = makeAddr("rulesKey");
    address payee = makeAddr("payee");
    address thief = makeAddr("thief");

    function setUp() public {
        vm.etch(PERMIT2, vm.parseJsonBytes(vm.readFile("test/fixtures/permit2-sepolia.json"), ".code"));
        usdc = new TestToken();
        router = new TestRouter();
        prints = new VerbatimPrints(PRICE, payee);
        prices = new TestPriceSource();
        prices.setPrice(address(usdc), 1e6, 1e6);
        prices.setPrice(ETH, 1 ether, 50_000e6);
        address[] memory trusted = new address[](2);
        trusted[0] = address(router);
        trusted[1] = address(prints);
        vault = new VerbatimVault(everydayKey, rulesKey, list(address(usdc)), address(new TestDirectory(trusted)));
        usdc.mint(address(vault), 10_000e6);
        usdc.mint(address(router), 10_000e6);
        vm.deal(address(vault), 1 ether);
        vm.deal(address(router), 10 ether);
        vm.startPrank(rulesKey);
        vault.setDailyLimit(address(usdc), 1000e6);
        vault.setDailyLimit(ETH, 0.01 ether);
        vault.setPriceSource(address(prices));
        vault.finishSetup();
        vm.stopPrank();
        vm.warp(vm.getBlockTimestamp() + 1 days);
    }

    function list(address item) internal pure returns (address[] memory items) {
        items = new address[](1);
        items[0] = item;
    }

    function mintAction(address to, uint256 value) internal view returns (VerbatimVault.Action[] memory actions) {
        actions = new VerbatimVault.Action[](1);
        actions[0] = VerbatimVault.Action(address(prints), value, abi.encodeCall(VerbatimPrints.mint, (to, ROOT)), 0);
    }

    function mintChecks() internal view returns (VerbatimVault.Check[] memory checks) {
        checks = new VerbatimVault.Check[](2);
        checks[0] = VerbatimVault.Check(VerbatimVault.CheckKind.AtMostLeaves, ETH, address(0), PRICE);
        checks[1] = VerbatimVault.Check(VerbatimVault.CheckKind.AtLeastArrives, address(prints), address(0), 1);
    }

    function run(VerbatimVault.Action[] memory actions, VerbatimVault.Check[] memory checks) internal {
        vm.prank(everydayKey);
        vault.run(actions, checks, vm.getBlockTimestamp());
    }

    function test_HonestMintPasses() public {
        run(mintAction(address(vault), PRICE), mintChecks());
        assertEq(prints.balanceOf(address(vault)), 1);
        assertEq(prints.imageRoot(1), ROOT);
        assertEq(address(vault).balance, 1 ether - PRICE);
        assertEq(payee.balance, PRICE);
    }

    function test_MintCountsTowardTheDailyLimit() public {
        vm.prank(rulesKey);
        vm.expectRevert("Only the everyday key can run");
        vault.run(mintAction(address(vault), PRICE), mintChecks(), vm.getBlockTimestamp());
        for (uint256 i = 0; i < 100; i++) {
            run(mintAction(address(vault), PRICE), mintChecks());
        }
        vm.expectRevert("Over the daily limit");
        run(mintAction(address(vault), PRICE), mintChecks());
    }

    function test_HackedSiteAskingTenTimesThePriceFails() public {
        vm.expectRevert(
            abi.encodeWithSelector(VerbatimVault.CheckFailed.selector, 1, "At most X leaves", PRICE, PRICE * 10)
        );
        run(mintAction(address(vault), PRICE * 10), mintChecks());
        assertEq(address(vault).balance, 1 ether);
    }

    function test_HackedSiteSendingThePrintToAThiefFails() public {
        vm.expectRevert(abi.encodeWithSelector(VerbatimVault.CheckFailed.selector, 2, "At least Y arrives", 1, 0));
        run(mintAction(thief, PRICE), mintChecks());
        assertEq(prints.balanceOf(thief), 0);
    }

    function test_HackedSiteDoingBothFails() public {
        vm.expectRevert(
            abi.encodeWithSelector(VerbatimVault.CheckFailed.selector, 1, "At most X leaves", PRICE, PRICE * 10)
        );
        run(mintAction(thief, PRICE * 10), mintChecks());
    }

    function test_PayingForNothingIsStillAnUnfairTrade() public {
        VerbatimVault.Check[] memory checks = new VerbatimVault.Check[](1);
        checks[0] = VerbatimVault.Check(VerbatimVault.CheckKind.AtMostLeaves, ETH, address(0), PRICE);
        vm.expectRevert("Unfair trade");
        run(mintAction(thief, PRICE), checks);
    }

    function test_UntrustedMintContractFails() public {
        VerbatimPrints fake = new VerbatimPrints(PRICE, thief);
        VerbatimVault.Action[] memory actions = new VerbatimVault.Action[](1);
        actions[0] = VerbatimVault.Action(address(fake), PRICE, abi.encodeCall(VerbatimPrints.mint, (address(vault), ROOT)), 0);
        VerbatimVault.Check[] memory checks = mintChecks();
        checks[1].token = address(fake);
        vm.expectRevert("Not a trusted contract");
        run(actions, checks);
    }

    function test_ABuyCheckDoesntExcuseAnUnfairSwap() public {
        VerbatimVault.Action[] memory actions = new VerbatimVault.Action[](4);
        actions[0] = VerbatimVault.Action(address(usdc), 0, abi.encodeCall(TestToken.approve, (PERMIT2, 100e6)), 0);
        actions[1] = VerbatimVault.Action(
            PERMIT2,
            0,
            abi.encodeCall(IPermit2.approve, (address(usdc), address(router), uint160(100e6), uint48(vm.getBlockTimestamp()))),
            0
        );
        actions[2] = VerbatimVault.Action(
            address(router), 0, abi.encodeCall(TestRouter.swapTo, (address(usdc), uint160(100e6), 0.0001 ether, address(vault))), 0
        );
        actions[3] = mintAction(address(vault), PRICE)[0];
        VerbatimVault.Check[] memory checks = new VerbatimVault.Check[](3);
        checks[0] = VerbatimVault.Check(VerbatimVault.CheckKind.AtMostLeaves, address(usdc), address(0), 100e6);
        checks[1] = VerbatimVault.Check(VerbatimVault.CheckKind.AtMostLeaves, ETH, address(0), PRICE);
        checks[2] = VerbatimVault.Check(VerbatimVault.CheckKind.AtLeastArrives, address(prints), address(0), 1);
        vm.expectRevert("Unfair trade");
        run(actions, checks);
    }

    function test_ABuyCheckForZeroItemsDoesntCount() public {
        VerbatimVault.Check[] memory checks = mintChecks();
        checks[1].amount = 0;
        vm.expectRevert("Unfair trade");
        run(mintAction(thief, PRICE), checks);
    }

    function test_ABuyCheckForAWatchedTokenDoesntCount() public {
        VerbatimVault.Check[] memory checks = new VerbatimVault.Check[](2);
        checks[0] = VerbatimVault.Check(VerbatimVault.CheckKind.AtMostLeaves, ETH, address(0), PRICE);
        checks[1] = VerbatimVault.Check(VerbatimVault.CheckKind.AtLeastArrives, address(usdc), address(0), 0);
        vm.expectRevert("Unfair trade");
        run(mintAction(thief, PRICE), checks);
    }

    function testFuzz_NeverMoreThanTheCapAndAlwaysThePrint(uint256 value, address to) public {
        value = bound(value, 0, 0.01 ether);
        vm.assume(to != address(0));
        uint256 printsBefore = prints.balanceOf(address(vault));
        vm.prank(everydayKey);
        try vault.run(mintAction(to, value), mintChecks(), vm.getBlockTimestamp()) {
            assertLe(1 ether - address(vault).balance, PRICE);
            assertEq(prints.balanceOf(address(vault)), printsBefore + 1);
            assertEq(to, address(vault));
        } catch {
            assertEq(address(vault).balance, 1 ether);
            assertEq(prints.balanceOf(address(vault)), printsBefore);
        }
    }

    function testFuzz_HonestPriceToTheVaultAlwaysPasses(uint8 times) public {
        times = uint8(bound(times, 1, 100));
        for (uint256 i = 0; i < times; i++) {
            run(mintAction(address(vault), PRICE), mintChecks());
        }
        assertEq(prints.balanceOf(address(vault)), times);
        assertEq(address(vault).balance, 1 ether - PRICE * times);
    }
}

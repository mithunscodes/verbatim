// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {VerbatimVault} from "../src/VerbatimVault.sol";
import {VaultFactory} from "../src/VaultFactory.sol";
import {TestDirectory} from "./TestDirectory.sol";
import {TestPriceSource} from "./TestPriceSource.sol";
import {TestRouter} from "./TestRouter.sol";
import {TestToken} from "./TestToken.sol";

contract MulticallTest is Test {
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    VerbatimVault vault;
    TestToken usdc;
    TestPriceSource prices;
    address alice = makeAddr("alice");
    address alicePhone = makeAddr("alicePhone");
    address stranger = makeAddr("stranger");
    address bob = makeAddr("bob");

    function setUp() public {
        vm.etch(PERMIT2, vm.parseJsonBytes(vm.readFile("test/fixtures/permit2-sepolia.json"), ".code"));
        usdc = new TestToken();
        prices = new TestPriceSource();
        address[] memory tokens = new address[](1);
        tokens[0] = address(usdc);
        address[] memory trusted = new address[](1);
        trusted[0] = address(new TestRouter());
        VaultFactory factory = new VaultFactory(tokens, address(new TestDirectory(trusted)));
        vm.prank(alice);
        vault = VerbatimVault(payable(factory.createVault(alicePhone)));
    }

    function setupCalls() internal view returns (bytes[] memory calls) {
        calls = new bytes[](8);
        calls[0] = abi.encodeCall(VerbatimVault.setDailyLimit, (address(usdc), 100e6));
        calls[1] = abi.encodeCall(VerbatimVault.setDailyLimit, (address(0), 0.01 ether));
        calls[2] = abi.encodeCall(VerbatimVault.setNewContactLimit, (address(usdc), 50e6));
        calls[3] = abi.encodeCall(VerbatimVault.setPriceSource, (address(prices)));
        calls[4] = abi.encodeCall(VerbatimVault.setLooseningWait, (120));
        calls[5] = abi.encodeCall(VerbatimVault.setNewContactPeriod, (60));
        calls[6] = abi.encodeCall(VerbatimVault.setAllowanceMinAge, (600));
        calls[7] = abi.encodeCall(VerbatimVault.finishSetup, ());
    }

    function test_RulesKeySetsUpEverythingInOneGo() public {
        vm.prank(alicePhone);
        vault.multicall(setupCalls());
        assertEq(vault.dailyLimit(address(usdc)), 100e6);
        assertEq(vault.dailyLimit(address(0)), 0.01 ether);
        assertEq(vault.newContactLimit(address(usdc)), 50e6);
        assertEq(vault.priceSource(), address(prices));
        assertEq(vault.looseningWait(), 120);
        assertEq(vault.newContactPeriod(), 60);
        assertEq(vault.allowanceMinAge(), 600);
        assertTrue(vault.setupFinished());
    }

    function test_OnlyTheRulesKeyCanMakeSeveralChanges() public {
        bytes[] memory calls = setupCalls();
        vm.expectRevert("Only the rules key can make several changes at once");
        vm.prank(alice);
        vault.multicall(calls);
        vm.expectRevert("Only the rules key can make several changes at once");
        vm.prank(stranger);
        vault.multicall(calls);
        assertFalse(vault.setupFinished());
    }

    function test_OneFailedChangeCancelsThemAll() public {
        bytes[] memory calls = new bytes[](3);
        calls[0] = abi.encodeCall(VerbatimVault.setDailyLimit, (address(usdc), 100e6));
        calls[1] = abi.encodeCall(VerbatimVault.finishSetup, ());
        calls[2] = abi.encodeCall(VerbatimVault.finishSetup, ());
        vm.expectRevert("One of the changes failed");
        vm.prank(alicePhone);
        vault.multicall(calls);
        assertEq(vault.dailyLimit(address(usdc)), 0);
        assertFalse(vault.setupFinished());
    }

    function test_CantSlipInAPayment() public {
        vm.prank(alicePhone);
        vault.multicall(setupCalls());
        usdc.mint(address(vault), 10e6);
        VerbatimVault.Action[] memory actions = new VerbatimVault.Action[](1);
        actions[0] = VerbatimVault.Action(address(usdc), 0, abi.encodeCall(TestToken.transfer, (bob, 1e6)), 0);
        VerbatimVault.Check[] memory checks = new VerbatimVault.Check[](0);
        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeCall(VerbatimVault.run, (actions, checks, vm.getBlockTimestamp() + 1 hours));
        vm.expectRevert("One of the changes failed");
        vm.prank(alicePhone);
        vault.multicall(calls);
        assertEq(usdc.balanceOf(address(vault)), 10e6);
    }

    function test_AfterSetupItCanOnlyTighten() public {
        vm.prank(alicePhone);
        vault.multicall(setupCalls());
        bytes[] memory looser = new bytes[](1);
        looser[0] = abi.encodeCall(VerbatimVault.setDailyLimit, (address(usdc), 1_000e6));
        vm.expectRevert("One of the changes failed");
        vm.prank(alicePhone);
        vault.multicall(looser);
        bytes[] memory tighter = new bytes[](1);
        tighter[0] = abi.encodeCall(VerbatimVault.setDailyLimit, (address(usdc), 10e6));
        vm.prank(alicePhone);
        vault.multicall(tighter);
        assertEq(vault.dailyLimit(address(usdc)), 10e6);
    }
}

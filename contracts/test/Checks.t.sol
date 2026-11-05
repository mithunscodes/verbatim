// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {VerbatimVault} from "../src/VerbatimVault.sol";
import {TestDirectory} from "./TestDirectory.sol";
import {TestToken} from "./TestToken.sol";
import {TestSwap} from "./TestSwap.sol";
import {TestPriceSource} from "./TestPriceSource.sol";
import {ReentryKey} from "./ReentryKey.sol";

contract ChecksTest is Test {
    VerbatimVault vault;
    TestToken usdc;
    TestSwap swap;
    TestPriceSource prices;
    address everydayKey = makeAddr("everydayKey");
    address rulesKey = makeAddr("rulesKey");
    address mom = makeAddr("mom");
    address thief = makeAddr("thief");
    address constant ETH = address(0);
    uint256 deadline;

    event Ran(bytes32 indexed actionsHash, bytes32 indexed checksHash, uint256 actionCount, uint256 deadline);

    function setUp() public {
        usdc = new TestToken();
        swap = new TestSwap();
        vault = new VerbatimVault(everydayKey, rulesKey, list(address(usdc)), address(new TestDirectory(list(address(swap)))));
        usdc.mint(address(vault), 100e6);
        vm.deal(address(vault), 1 ether);
        vm.deal(address(swap), 10 ether);
        prices = new TestPriceSource();
        prices.setPrice(address(usdc), 1e6, 1e6);
        prices.setPrice(ETH, 1 ether, 3334e6);
        vm.startPrank(rulesKey);
        vault.saveContact(mom);
        vault.saveContact(thief);
        vault.setDailyLimit(address(usdc), 100e6);
        vault.setDailyLimit(ETH, 1 ether);
        vault.setPriceSource(address(prices));
        vault.finishSetup();
        vm.stopPrank();
        vm.warp(block.timestamp + 1 days);
        deadline = block.timestamp + 5 minutes;
    }

    function list(address item) internal pure returns (address[] memory items) {
        items = new address[](1);
        items[0] = item;
    }

    function sendUsdc(address to, uint256 amount) internal view returns (VerbatimVault.Action memory) {
        return VerbatimVault.Action(address(usdc), 0, abi.encodeCall(TestToken.transfer, (to, amount)), 0);
    }

    function swapPays(uint256 ethOut) internal view returns (VerbatimVault.Action memory) {
        return VerbatimVault.Action(address(swap), 0, abi.encodeCall(TestSwap.swap, (address(usdc), 10e6, ethOut)), 0);
    }

    function heroActions(uint256 ethOut, address recipient, uint256 amount) internal view returns (VerbatimVault.Action[] memory actions) {
        actions = new VerbatimVault.Action[](3);
        actions[0] = VerbatimVault.Action(address(usdc), 0, abi.encodeCall(TestToken.approve, (address(swap), 10e6)), 0);
        actions[1] = swapPays(ethOut);
        actions[2] = sendUsdc(recipient, amount);
    }

    function heroChecks() internal view returns (VerbatimVault.Check[] memory checks) {
        checks = new VerbatimVault.Check[](3);
        checks[0] = VerbatimVault.Check(VerbatimVault.CheckKind.AtMostLeaves, address(usdc), address(0), 12e6);
        checks[1] = VerbatimVault.Check(VerbatimVault.CheckKind.AtLeastArrives, ETH, address(0), 0.003 ether);
        checks[2] = VerbatimVault.Check(VerbatimVault.CheckKind.ExactlyTo, address(usdc), mom, 2e6);
    }

    function failure(uint256 checkNumber, string memory check, uint256 expected, uint256 actual) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(VerbatimVault.CheckFailed.selector, checkNumber, check, expected, actual);
    }

    function runAsEverydayKey(VerbatimVault.Action[] memory actions, VerbatimVault.Check[] memory checks) internal {
        vm.prank(everydayKey);
        vault.run(actions, checks, deadline);
    }

    function assertNothingMoved() internal view {
        assertEq(usdc.balanceOf(address(vault)), 100e6);
        assertEq(address(vault).balance, 1 ether);
        assertEq(usdc.balanceOf(mom), 0);
        assertEq(usdc.balanceOf(thief), 0);
    }

    function test_HonestRequestPassesAllThreeChecks() public {
        VerbatimVault.Action[] memory actions = heroActions(0.0035 ether, mom, 2e6);
        VerbatimVault.Check[] memory checks = heroChecks();
        vm.expectEmit(address(vault));
        emit Ran(keccak256(abi.encode(actions)), keccak256(abi.encode(checks)), 3, deadline);
        runAsEverydayKey(actions, checks);
        assertEq(usdc.balanceOf(address(vault)), 88e6);
        assertEq(address(vault).balance, 1.0035 ether);
        assertEq(usdc.balanceOf(mom), 2e6);
    }

    function test_PassesAtExactLimits() public {
        runAsEverydayKey(heroActions(0.003 ether, mom, 2e6), heroChecks());
        assertEq(usdc.balanceOf(address(vault)), 88e6);
        assertEq(address(vault).balance, 1.003 ether);
    }

    function test_AtMostLeaves_FailsOnHiddenExtraTransfer() public {
        VerbatimVault.Action[] memory honest = heroActions(0.0035 ether, mom, 2e6);
        VerbatimVault.Action[] memory actions = new VerbatimVault.Action[](4);
        for (uint256 i = 0; i < 3; i++) {
            actions[i] = honest[i];
        }
        actions[3] = sendUsdc(thief, 5e6);
        vm.expectRevert(failure(1, "At most X leaves", 12e6, 17e6));
        runAsEverydayKey(actions, heroChecks());
        assertNothingMoved();
    }

    function test_AtLeastArrives_FailsOnBadPrice() public {
        vm.expectRevert(failure(2, "At least Y arrives", 0.003 ether, 0.001 ether));
        runAsEverydayKey(heroActions(0.001 ether, mom, 2e6), heroChecks());
        assertNothingMoved();
    }

    function test_ExactlyTo_FailsOnWrongAmount() public {
        vm.expectRevert(failure(3, "Exactly X to this address", 2e6, 1e6));
        runAsEverydayKey(heroActions(0.0035 ether, mom, 1e6), heroChecks());
        assertNothingMoved();
    }

    function test_ExactlyTo_FailsOnTooMuch() public {
        VerbatimVault.Check[] memory checks = new VerbatimVault.Check[](1);
        checks[0] = heroChecks()[2];
        vm.expectRevert(failure(1, "Exactly X to this address", 2e6, 3e6));
        runAsEverydayKey(heroActions(0.0035 ether, mom, 3e6), checks);
        assertNothingMoved();
    }

    function test_ExactlyTo_FailsWhenSentElsewhere() public {
        vm.expectRevert(failure(3, "Exactly X to this address", 2e6, 0));
        runAsEverydayKey(heroActions(0.0035 ether, thief, 2e6), heroChecks());
        assertNothingMoved();
    }

    function test_EthCanBeCheckedToo() public {
        VerbatimVault.Action[] memory actions = new VerbatimVault.Action[](1);
        actions[0] = VerbatimVault.Action(mom, 0.5 ether, "", 0);
        VerbatimVault.Check[] memory checks = new VerbatimVault.Check[](2);
        checks[0] = VerbatimVault.Check(VerbatimVault.CheckKind.AtMostLeaves, ETH, address(0), 0.2 ether);
        checks[1] = VerbatimVault.Check(VerbatimVault.CheckKind.ExactlyTo, ETH, mom, 0.5 ether);
        vm.expectRevert(failure(1, "At most X leaves", 0.2 ether, 0.5 ether));
        runAsEverydayKey(actions, checks);
        assertEq(mom.balance, 0);
        checks[0].amount = 0.5 ether;
        runAsEverydayKey(actions, checks);
        assertEq(mom.balance, 0.5 ether);
    }

    function test_ReentryIsBlocked() public {
        ReentryKey key = new ReentryKey();
        VerbatimVault keyVault = new VerbatimVault(address(key), rulesKey, new address[](0), address(new TestDirectory(list(address(key)))));
        key.setVault(keyVault);
        vm.prank(rulesKey);
        keyVault.finishSetup();
        VerbatimVault.Action[] memory actions = new VerbatimVault.Action[](1);
        actions[0] = VerbatimVault.Action(address(key), 0, abi.encodeCall(ReentryKey.reenter, ()), 0);
        key.start(actions, deadline);
        assertEq(key.reason(), "Already running");
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {VerbatimVault} from "../src/VerbatimVault.sol";
import {TestDirectory} from "./TestDirectory.sol";
import {TestResolver} from "./TestResolver.sol";
import {TestToken} from "./TestToken.sol";

contract EnsNameTest is Test {
    string constant NAME = "alice.eth";

    VerbatimVault vault;
    TestDirectory directory;
    TestResolver resolver;
    TestToken usdc;
    address everydayKey = makeAddr("everydayKey");
    address rulesKey = makeAddr("rulesKey");

    function setUp() public {
        usdc = new TestToken();
        directory = new TestDirectory(new address[](0));
        resolver = new TestResolver();
        directory.setResolver(NAME, address(resolver));
        directory.addRecord(abi.encodeWithSignature("setText(bytes,string,string)", hex"05616c69636503657468", "verbatim.test", "1"));
        address[] memory watched = new address[](1);
        watched[0] = address(usdc);
        vault = new VerbatimVault(everydayKey, rulesKey, watched, address(directory));
    }

    function test_SetEnsNameStoresTheNameAndResolver() public {
        vm.prank(rulesKey);
        vault.setEnsName(NAME);
        assertEq(vault.ensName(), NAME);
        assertEq(vault.ensResolver(), address(resolver));
        assertEq(resolver.calls(), 1);
        assertEq(resolver.lastCaller(), address(vault));
    }

    function test_EveryRuleAndChangeIsPublished() public {
        vm.startPrank(rulesKey);
        vault.setEnsName(NAME);
        vault.setDailyLimit(address(usdc), 100e6);
        vault.finishSetup();
        vm.stopPrank();
        assertEq(resolver.calls(), 2);
        vm.prank(everydayKey);
        uint256 id = vault.propose(VerbatimVault.ChangeKind.DailyLimit, address(0), address(usdc), 200e6);
        assertEq(resolver.calls(), 3);
        vm.prank(rulesKey);
        vault.approve(id);
        assertEq(resolver.calls(), 4);
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        vault.switchOn(id);
        assertEq(resolver.calls(), 6);
        vm.prank(everydayKey);
        uint256 second = vault.propose(VerbatimVault.ChangeKind.DailyLimit, address(0), address(usdc), 300e6);
        vm.prank(rulesKey);
        vault.cancel(second);
        assertEq(resolver.calls(), 8);
    }

    function test_NothingIsPublishedWithoutAName() public {
        vm.prank(rulesKey);
        vault.setDailyLimit(address(usdc), 100e6);
        assertEq(resolver.calls(), 0);
    }

    function test_RevertWhen_NotTheRulesKey() public {
        vm.prank(everydayKey);
        vm.expectRevert("Only the rules key can change settings");
        vault.setEnsName(NAME);
    }

    function test_RevertWhen_SetupFinished() public {
        vm.startPrank(rulesKey);
        vault.finishSetup();
        vm.expectRevert("Setup already finished");
        vault.setEnsName(NAME);
        vm.stopPrank();
    }

    function test_RevertWhen_NameHasNoGenuineResolver() public {
        vm.prank(rulesKey);
        vm.expectRevert("This name has no genuine ENS resolver");
        vault.setEnsName("bob.eth");
    }

    function test_RevertWhen_TooLittleGasToUpdateEns() public {
        vm.startPrank(rulesKey);
        vault.setEnsName(NAME);
        vm.expectRevert("Not enough gas to update ENS");
        vault.setDailyLimit{gas: 2_000_000}(address(usdc), 100e6);
        vault.setDailyLimit{gas: 4_000_000}(address(usdc), 100e6);
        vm.stopPrank();
        assertEq(vault.dailyLimit(address(usdc)), 100e6);
        assertEq(resolver.calls(), 2);
    }

    function test_NoGasFloorWithoutAName() public {
        vm.prank(rulesKey);
        vault.setDailyLimit{gas: 200_000}(address(usdc), 100e6);
        assertEq(vault.dailyLimit(address(usdc)), 100e6);
    }

    function test_BrokenResolverNeverBlocksTheVault() public {
        vm.startPrank(rulesKey);
        vault.setEnsName(NAME);
        resolver.setBroken(true);
        vault.setDailyLimit(address(usdc), 100e6);
        vault.finishSetup();
        vm.stopPrank();
        vm.prank(everydayKey);
        uint256 id = vault.propose(VerbatimVault.ChangeKind.DailyLimit, address(0), address(usdc), 200e6);
        vm.prank(rulesKey);
        vault.approve(id);
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        vault.switchOn(id);
        assertEq(vault.dailyLimit(address(usdc)), 200e6);
        assertEq(resolver.calls(), 1);
    }

    function test_BrokenDirectoryNeverBlocksTheVault() public {
        vm.startPrank(rulesKey);
        vault.setEnsName(NAME);
        directory.setBroken(true);
        vault.setDailyLimit(address(usdc), 100e6);
        vm.stopPrank();
        assertEq(vault.dailyLimit(address(usdc)), 100e6);
        assertEq(resolver.calls(), 1);
    }
}

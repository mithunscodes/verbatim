// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {VerbatimVault} from "../src/VerbatimVault.sol";
import {TestDirectory} from "./TestDirectory.sol";
import {VaultFactory} from "../src/VaultFactory.sol";
import {TestToken} from "./TestToken.sol";
import {TestRouter} from "./TestRouter.sol";

contract VaultFactoryTest is Test {
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    uint256 constant SIZE_LIMIT = 24_576;

    VaultFactory factory;
    TestToken usdc;
    TestRouter router;
    address alice = makeAddr("alice");
    address alicePhone = makeAddr("alicePhone");
    address bob = makeAddr("bob");
    address mom = makeAddr("mom");

    event VaultCreated(address indexed vault, address indexed everydayKey, address indexed rulesKey);

    function setUp() public {
        vm.etch(PERMIT2, vm.parseJsonBytes(vm.readFile("test/fixtures/permit2-sepolia.json"), ".code"));
        usdc = new TestToken();
        router = new TestRouter();
        factory = new VaultFactory(list(address(usdc)), address(new TestDirectory(list(address(router)))));
    }

    function list(address item) internal pure returns (address[] memory items) {
        items = new address[](1);
        items[0] = item;
    }

    function createFor(address everydayKey, address rulesKey) internal returns (VerbatimVault) {
        vm.prank(everydayKey);
        return VerbatimVault(payable(factory.createVault(rulesKey)));
    }

    function sendUsdc(VerbatimVault vault, address to, uint256 amount, bytes memory refusal) internal {
        VerbatimVault.Action[] memory actions = new VerbatimVault.Action[](1);
        actions[0] = VerbatimVault.Action(address(usdc), 0, abi.encodeCall(TestToken.transfer, (to, amount)), 0);
        VerbatimVault.Check[] memory checks = new VerbatimVault.Check[](2);
        checks[0] = VerbatimVault.Check(VerbatimVault.CheckKind.AtMostLeaves, address(usdc), address(0), amount);
        checks[1] = VerbatimVault.Check(VerbatimVault.CheckKind.ExactlyTo, address(usdc), to, amount);
        address everydayKey = vault.everydayKey();
        if (refusal.length > 0) vm.expectRevert(refusal);
        vm.prank(everydayKey);
        vault.run(actions, checks, vm.getBlockTimestamp() + 1 hours);
    }

    function test_CreateVaultSetsTheRightKeys() public {
        vm.expectEmit(false, true, true, false);
        emit VaultCreated(address(0), alice, alicePhone);
        VerbatimVault vault = createFor(alice, alicePhone);
        assertEq(vault.everydayKey(), alice);
        assertEq(vault.rulesKey(), alicePhone);
        assertEq(vault.watchedTokens(0), address(usdc));
        assertEq(vault.directory(), factory.directory());
        assertTrue(TestDirectory(vault.directory()).isListed(address(router)));
        assertEq(factory.vaultOf(alice), address(vault));
        address[] memory guarded = factory.vaultsGuardedBy(alicePhone);
        assertEq(guarded.length, 1);
        assertEq(guarded[0], address(vault));
        assertFalse(vault.setupFinished());
    }

    function test_SameCodeAsTheTestedVault() public {
        VerbatimVault fromFactory = createFor(alice, alicePhone);
        VerbatimVault direct = new VerbatimVault(bob, alicePhone, list(address(usdc)), address(new TestDirectory(list(address(router)))));
        assertEq(keccak256(address(fromFactory).code), keccak256(address(direct).code));
    }

    function test_FactoryFitsTheSizeLimit() public view {
        assertLt(address(factory).code.length, SIZE_LIMIT);
    }

    function test_OneVaultPerEverydayKey() public {
        createFor(alice, alicePhone);
        vm.prank(alice);
        vm.expectRevert("You already have a vault");
        factory.createVault(alicePhone);
    }

    function test_KeysMustBeDifferentAndNotEmpty() public {
        vm.startPrank(alice);
        vm.expectRevert("The two keys must be different");
        factory.createVault(alice);
        vm.expectRevert("Keys can't be empty");
        factory.createVault(address(0));
        vm.stopPrank();
        assertEq(factory.vaultOf(alice), address(0));
    }

    function test_NobodyCanMakeYouTheEverydayKey() public {
        VerbatimVault bobs = createFor(bob, alicePhone);
        assertEq(bobs.everydayKey(), bob);
        assertEq(factory.vaultOf(alice), address(0));
    }

    function test_NewVaultCantSendBeforeSetup() public {
        VerbatimVault vault = createFor(alice, alicePhone);
        usdc.mint(address(vault), 100e6);
        sendUsdc(vault, mom, 1e6, "Finish setting up first");
    }

    function test_NewVaultCantSendUntilThePhoneSetsALimit() public {
        VerbatimVault vault = createFor(alice, alicePhone);
        usdc.mint(address(vault), 100e6);
        vm.startPrank(alicePhone);
        vault.saveContact(mom);
        vault.finishSetup();
        vm.stopPrank();
        vm.warp(vm.getBlockTimestamp() + 1 days);
        sendUsdc(vault, mom, 1e6, "Over the daily limit");
        assertEq(usdc.balanceOf(mom), 0);
    }

    function test_SendsOnceThePhoneSetsALimit() public {
        VerbatimVault vault = createFor(alice, alicePhone);
        usdc.mint(address(vault), 100e6);
        vm.startPrank(alicePhone);
        vault.saveContact(mom);
        vault.setDailyLimit(address(usdc), 10e6);
        vault.finishSetup();
        vm.stopPrank();
        vm.warp(vm.getBlockTimestamp() + 1 days);
        sendUsdc(vault, mom, 2e6, "");
        assertEq(usdc.balanceOf(mom), 2e6);
    }

    function test_CreatorHasOnlyTheEverydayKeysPowers() public {
        VerbatimVault vault = createFor(alice, alicePhone);
        vm.startPrank(alice);
        vm.expectRevert("Only the rules key can save contacts");
        vault.saveContact(mom);
        vm.expectRevert("Only the rules key can set limits");
        vault.setDailyLimit(address(usdc), 10e6);
        vm.expectRevert("Only the rules key can finish setup");
        vault.finishSetup();
        vm.stopPrank();
    }

    function test_FactoryKeepsNoControl() public {
        VerbatimVault vault = createFor(alice, alicePhone);
        vm.startPrank(address(factory));
        vm.expectRevert("Only the rules key can save contacts");
        vault.saveContact(mom);
        vm.expectRevert("Only the rules key can finish setup");
        vault.finishSetup();
        vm.expectRevert("Only the everyday key can run");
        vault.run(new VerbatimVault.Action[](0), new VerbatimVault.Check[](0), vm.getBlockTimestamp() + 1 hours);
        vm.expectRevert("Only the everyday key can propose");
        vault.propose(VerbatimVault.ChangeKind.DailyLimit, address(0), address(usdc), 1e6);
        vm.stopPrank();
    }
}

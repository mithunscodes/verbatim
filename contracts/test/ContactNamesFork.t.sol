// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console} from "forge-std/console.sol";
import {VerbatimVault} from "../src/VerbatimVault.sol";
import {EnsDirectory} from "../src/EnsDirectory.sol";
import {EnsSettings} from "../script/EnsSettings.sol";
import {DirectoryFork, IRegistry, IPermissionedResolver} from "./DirectoryFork.sol";

contract ContactNamesForkTest is DirectoryFork {
    address everydayKey = makeAddr("everydayKey");
    address rulesKey = makeAddr("rulesKey");
    address mom = makeAddr("mom");
    address ravi = makeAddr("ravi");
    address raviNew = makeAddr("raviNew");
    address thief = makeAddr("thief");
    EnsDirectory directory;
    VerbatimVault vault;

    function setUp() public {
        if (!buildDirectory()) return;
        directory = EnsSettings.deployDirectory();
        vault = new VerbatimVault(everydayKey, rulesKey, accounts(USDC), address(directory));
        vm.deal(address(vault), 1 ether);
        setUpUserName(address(vault), rulesKey, everydayKey, ravi);
        vm.startPrank(rulesKey);
        vault.saveContact(mom);
        vault.saveContactName(userSubname("ravi"));
        vault.setDailyLimit(address(0), 1 ether);
        vault.setNewContactLimit(address(0), 0.02 ether);
        vault.finishSetup();
        vm.stopPrank();
        vm.warp(vm.getBlockTimestamp() + 30 days);
    }

    function payEth(address to, uint256 amount) internal {
        VerbatimVault.Action[] memory actions = new VerbatimVault.Action[](1);
        actions[0] = VerbatimVault.Action(to, amount, "", 0);
        VerbatimVault.Check[] memory checks = new VerbatimVault.Check[](1);
        checks[0] = VerbatimVault.Check(VerbatimVault.CheckKind.AtMostLeaves, address(0), address(0), amount);
        vm.prank(everydayKey);
        vault.run(actions, checks, vm.getBlockTimestamp());
    }

    function pointRavi(address to) internal {
        vm.prank(rulesKey);
        IPermissionedResolver(userResolver).setAddress(dns(userSubname("ravi")), ETH_COIN_TYPE, abi.encodePacked(to));
    }

    function test_YourNameIsOwnedByThePhone() public view {
        assertEq(IRegistry(EnsSettings.ETH_REGISTRY).findOwner(USER_LABEL), rulesKey);
        assertEq(userRegistry.findOwner("ravi"), rulesKey);
        (address resolver, address record) = lookup(userName());
        assertEq(resolver, userResolver);
        assertEq(record, address(vault));
        (, record) = lookup(userSubname("ravi"));
        assertEq(record, ravi);
        assertFalse(userRegistry.hasRootRoles(ROLE_REGISTRAR, builder));
    }

    function test_SendToRaviWorks() public {
        assertEq(vault.nameOf(ravi), userSubname("ravi"));
        payEth(ravi, 0.1 ether);
        assertEq(ravi.balance, 0.1 ether);
    }

    function test_RevertWhen_SendToUnsavedAddress() public {
        vm.expectRevert("Not a saved contact");
        payEth(thief, 0.1 ether);
    }

    function test_SendToASavedNameThatStillMatchesWorks() public {
        pointRavi(ravi);
        payEth(ravi, 0.1 ether);
        assertEq(ravi.balance, 0.1 ether);
    }

    function test_RevertWhen_NamePointedElsewhere() public {
        pointRavi(thief);
        vm.expectRevert("This contact's address changed");
        payEth(ravi, 0.1 ether);
        vm.expectRevert("Not a saved contact");
        payEth(thief, 0.1 ether);
    }

    function test_RevertWhen_ContactNameExpired() public {
        payEth(ravi, 0.1 ether);
        vm.warp(uint256(IRegistry(EnsSettings.ETH_REGISTRY).findExpiry(USER_LABEL)) + 1);
        vm.expectRevert("This contact's address changed");
        payEth(ravi, 0.1 ether);
    }

    function test_DirectoryNamesStopCountingWhenTheyExpire() public {
        address[] memory before = directory.listed();
        assertGt(before.length, 0);
        assertTrue(directory.isListed(before[0]));
        vm.warp(uint256(expiry) + 1);
        assertEq(directory.listed().length, 0);
        assertFalse(directory.isListed(before[0]));
    }

    function test_AfterReapprovalAndTheWaitSendsWorkCapped() public {
        pointRavi(raviNew);
        vm.prank(everydayKey);
        uint256 id = vault.propose(VerbatimVault.ChangeKind.ContactAddress, ravi, address(0), uint256(uint160(raviNew)));
        vm.prank(rulesKey);
        vault.approve(id);
        vm.expectRevert("Not a saved contact");
        payEth(raviNew, 0.01 ether);
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        vault.switchOn(id);
        payEth(raviNew, 0.02 ether);
        vm.expectRevert("Over the new-contact limit");
        payEth(raviNew, 0.001 ether);
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        payEth(raviNew, 0.1 ether);
        assertEq(raviNew.balance, 0.12 ether);
    }

    function test_RevertWhen_EverydayKeyRepointsAContact() public {
        bytes memory name = dns(userSubname("ravi"));
        vm.startPrank(everydayKey);
        vm.expectPartialRevert(UNAUTHORIZED);
        IPermissionedResolver(userResolver).setAddress(name, ETH_COIN_TYPE, abi.encodePacked(thief));
        vm.expectPartialRevert(UNAUTHORIZED);
        userRegistry.register("thief", everydayKey, address(0), userResolver, ORGANIZATION_ROLES, uint64(vm.getBlockTimestamp() + 1 days));
        vm.stopPrank();
    }

    function test_Gas() public {
        VerbatimVault.Action[] memory actions = new VerbatimVault.Action[](1);
        VerbatimVault.Check[] memory checks = new VerbatimVault.Check[](1);
        checks[0] = VerbatimVault.Check(VerbatimVault.CheckKind.AtMostLeaves, address(0), address(0), 0.1 ether);
        vm.cool(address(vault));
        actions[0] = VerbatimVault.Action(mom, 0.1 ether, "", 0);
        vm.prank(everydayKey);
        vault.run(actions, checks, vm.getBlockTimestamp());
        uint256 plain = vm.lastFrameGas().gasTotalUsed;
        vm.cool(address(vault));
        actions[0] = VerbatimVault.Action(ravi, 0.1 ether, "", 0);
        vm.prank(everydayKey);
        vault.run(actions, checks, vm.getBlockTimestamp());
        uint256 named = vm.lastFrameGas().gasTotalUsed;
        console.log("Payment to a contact saved by address:", plain);
        console.log("Payment to a contact saved by ENS name:", named);
        console.log("Extra cost of re-reading the name:", named - plain);
        assertLt(named - plain, 150_000);
    }
}

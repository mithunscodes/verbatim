// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {VerbatimVault} from "../src/VerbatimVault.sol";
import {EnsDirectory} from "../src/EnsDirectory.sol";
import {EnsSettings} from "../script/EnsSettings.sol";
import {DirectoryFork, IPermissionedResolver} from "./DirectoryFork.sol";

contract TemporaryContactsForkTest is DirectoryFork {
    bytes4 constant LABEL_EXPIRED = bytes4(keccak256("LabelExpired(uint256)"));

    address everydayKey = makeAddr("everydayKey");
    address rulesKey = makeAddr("rulesKey");
    address ravi = makeAddr("ravi");
    address plumber = makeAddr("plumber");
    address thief = makeAddr("thief");
    EnsDirectory directory;
    VerbatimVault vault;
    uint64 ends;

    function setUp() public {
        if (!buildDirectory()) return;
        directory = EnsSettings.deployDirectory();
        vault = new VerbatimVault(everydayKey, rulesKey, accounts(USDC), address(directory));
        vm.deal(address(vault), 1 ether);
        setUpUserName(address(vault), rulesKey, everydayKey, ravi);
        vm.startPrank(rulesKey);
        vault.saveContactName(userSubname("ravi"));
        vault.setDailyLimit(address(0), 1 ether);
        vault.setNewContactLimit(address(0), 0.02 ether);
        vault.finishSetup();
        vm.stopPrank();
        vm.warp(vm.getBlockTimestamp() + 30 days);
        ends = uint64(vm.getBlockTimestamp() + 1 days);
        vm.startPrank(rulesKey);
        userRegistry.register("plumber", rulesKey, address(0), userResolver, ORGANIZATION_ROLES, ends);
        IPermissionedResolver(userResolver).setAddress(dns(userSubname("plumber")), ETH_COIN_TYPE, abi.encodePacked(plumber));
        vault.saveContactName(userSubname("plumber"));
        vm.stopPrank();
    }

    function labelId(string memory label) internal pure returns (uint256) {
        return uint256(keccak256(bytes(label)));
    }

    function payEth(address to, uint256 amount) internal {
        VerbatimVault.Action[] memory actions = new VerbatimVault.Action[](1);
        actions[0] = VerbatimVault.Action(to, amount, "", 0);
        VerbatimVault.Check[] memory checks = new VerbatimVault.Check[](1);
        checks[0] = VerbatimVault.Check(VerbatimVault.CheckKind.AtMostLeaves, address(0), address(0), amount);
        vm.prank(everydayKey);
        vault.run(actions, checks, vm.getBlockTimestamp());
    }

    function test_ATemporaryContactCanBePaidUntilItEnds() public {
        assertEq(userRegistry.findExpiry("plumber"), ends);
        payEth(plumber, 0.01 ether);
        vm.warp(ends - 1);
        payEth(plumber, 0.01 ether);
        vm.warp(ends);
        vm.expectRevert("This contact's address changed");
        payEth(plumber, 0.001 ether);
        assertEq(plumber.balance, 0.02 ether);
    }

    function test_AnEndedContactCantBePaidByItsAddressEither() public {
        vm.warp(ends);
        assertEq(directory.addressOf(userSubname("plumber")), address(0));
        assertEq(vault.nameOf(plumber), userSubname("plumber"));
        vm.expectRevert("This contact's address changed");
        payEth(plumber, 0.01 ether);
    }

    function test_RenewingBeforeTheEndKeepsItWorking() public {
        vm.prank(rulesKey);
        userRegistry.renew(labelId("plumber"), ends + 7 days);
        vm.warp(ends + 1 days);
        payEth(plumber, 0.01 ether);
        assertEq(plumber.balance, 0.01 ether);
    }

    function test_RenewingAfterTheEndMakesItWorkAgain() public {
        vm.warp(ends + 1 hours);
        vm.expectRevert("This contact's address changed");
        payEth(plumber, 0.01 ether);
        vm.prank(rulesKey);
        userRegistry.renew(labelId("plumber"), uint64(vm.getBlockTimestamp() + 1 days));
        payEth(plumber, 0.01 ether);
        assertEq(plumber.balance, 0.01 ether);
    }

    function test_EndingItEarlyStopsPayments() public {
        payEth(plumber, 0.01 ether);
        vm.prank(rulesKey);
        userRegistry.unregister(labelId("plumber"));
        assertEq(userRegistry.findExpiry("plumber"), vm.getBlockTimestamp());
        vm.expectRevert("This contact's address changed");
        payEth(plumber, 0.01 ether);
        assertEq(plumber.balance, 0.01 ether);
    }

    function test_AnEndedNameGivenToSomeoneElseStillFails() public {
        vm.warp(ends);
        vm.startPrank(rulesKey);
        userRegistry.register("plumber", rulesKey, address(0), userResolver, ORGANIZATION_ROLES, ends + 1 days);
        IPermissionedResolver(userResolver).setAddress(dns(userSubname("plumber")), ETH_COIN_TYPE, abi.encodePacked(thief));
        vm.stopPrank();
        vm.expectRevert("This contact's address changed");
        payEth(plumber, 0.01 ether);
        vm.expectRevert("Not a saved contact");
        payEth(thief, 0.01 ether);
    }

    function test_RevertWhen_EverydayKeyRenewsOrEndsAContact() public {
        vm.startPrank(everydayKey);
        vm.expectPartialRevert(UNAUTHORIZED);
        userRegistry.renew(labelId("plumber"), ends + 365 days);
        vm.expectPartialRevert(UNAUTHORIZED);
        userRegistry.unregister(labelId("plumber"));
        vm.warp(ends);
        vm.expectPartialRevert(LABEL_EXPIRED);
        userRegistry.renew(labelId("plumber"), ends + 365 days);
        vm.stopPrank();
    }

    function test_KeepStillWorksAfterATemporaryContactEnds() public {
        vm.warp(ends + 1 days);
        payEth(ravi, 0.1 ether);
        assertEq(ravi.balance, 0.1 ether);
    }
}

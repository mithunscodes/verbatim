// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console} from "forge-std/console.sol";
import {VerbatimVault} from "../src/VerbatimVault.sol";
import {EnsDirectory} from "../src/EnsDirectory.sol";
import {EnsSettings} from "../script/EnsSettings.sol";
import {DirectoryFork, IPermissionedResolver} from "./DirectoryFork.sol";

contract EnsRulesForkTest is DirectoryFork {
    address everydayKey = makeAddr("everydayKey");
    address rulesKey = makeAddr("rulesKey");
    address mom = makeAddr("mom");
    address ravi = makeAddr("ravi");
    address raviNew = makeAddr("raviNew");
    EnsDirectory directory;
    VerbatimVault vault;

    function setUp() public {
        if (!buildDirectory()) return;
        directory = EnsSettings.deployDirectory();
        vault = newVault();
        setUpUserName(address(vault), rulesKey, everydayKey, ravi);
        vm.startPrank(rulesKey);
        vault.setEnsName(userName());
        vault.saveContact(mom);
        vault.saveContactName(userSubname("ravi"));
        vault.setDailyLimit(address(0), 1 ether);
        vault.setNewContactLimit(address(0), 0.02 ether);
        vault.finishSetup();
        vm.stopPrank();
    }

    function newVault() internal returns (VerbatimVault) {
        return new VerbatimVault(everydayKey, rulesKey, accounts(USDC), address(directory));
    }

    function rule(string memory key) internal view returns (string memory) {
        return readText(userName(), string.concat("verbatim.", key));
    }

    function proposeLimit(uint256 amount) internal returns (uint256 id) {
        vm.prank(everydayKey);
        id = vault.propose(VerbatimVault.ChangeKind.DailyLimit, address(0), address(0), amount);
    }

    function test_TheVaultKnowsItsName() public view {
        assertEq(vault.ensName(), userName());
        assertEq(vault.ensResolver(), userResolver);
    }

    function test_RulesAppearInEns() public view {
        assertEq(rule("dailyLimit.ETH"), "1 ETH");
        assertEq(rule("newContactLimit.ETH"), "0.02 ETH");
        assertEq(rule("dailyLimit.USDC"), "0 USDC");
        assertEq(rule("newContactLimit.USDC"), "0 USDC");
        assertEq(rule("allowanceValidity"), "2 days");
        assertEq(rule("newContactPeriod"), "1 day");
        assertEq(rule("allowanceMinAge"), "7 days");
        assertEq(rule("looseningWait"), "1 day");
        assertEq(rule("tradeTolerance"), "3%");
        assertEq(rule("priceSource"), "none");
        assertEq(rule(string.concat("contact.", userSubname("ravi"))), vm.toLowercase(vm.toString(ravi)));
    }

    function test_RevertWhen_EverydayKeyEditsTheRules() public {
        bytes memory name = dns(userName());
        vm.prank(everydayKey);
        vm.expectPartialRevert(UNAUTHORIZED);
        IPermissionedResolver(userResolver).setText(name, "verbatim.dailyLimit.ETH", "1000 ETH");
        vm.prank(rulesKey);
        vm.expectPartialRevert(UNAUTHORIZED);
        IPermissionedResolver(userResolver).setText(name, "verbatim.dailyLimit.ETH", "1000 ETH");
        assertEq(rule("dailyLimit.ETH"), "1 ETH");
        vm.prank(everydayKey);
        IPermissionedResolver(userResolver).setText(name, "avatar", "https://example.com/alice.png");
        assertEq(readText(userName(), "avatar"), "https://example.com/alice.png");
    }

    function test_ApprovedChangeAppearsInEnsAfterTheWait() public {
        uint256 id = proposeLimit(2 ether);
        assertEq(
            rule("change.0"),
            '{"id":0,"kind":0,"change":"Daily limit for ETH: 2 ETH","status":"proposed","readyAt":0,"expiresAt":0}'
        );
        assertEq(rule("changeCount"), "1");
        vm.prank(rulesKey);
        vault.approve(id);
        (,,,,, uint256 readyAt, uint256 expiresAt,,) = vault.changes(id);
        string memory times = string.concat(',"readyAt":', vm.toString(readyAt), ',"expiresAt":', vm.toString(expiresAt), "}");
        assertEq(rule("change.0"), string.concat('{"id":0,"kind":0,"change":"Daily limit for ETH: 2 ETH","status":"approved"', times));
        assertEq(rule("dailyLimit.ETH"), "1 ETH");
        vm.warp(readyAt);
        vault.switchOn(id);
        assertEq(rule("dailyLimit.ETH"), "2 ETH");
        assertEq(rule("change.0"), string.concat('{"id":0,"kind":0,"change":"Daily limit for ETH: 2 ETH","status":"switched on"', times));
    }

    function test_CancelledChangeShowsInEns() public {
        uint256 id = proposeLimit(5 ether);
        vm.prank(rulesKey);
        vault.cancel(id);
        assertEq(
            rule("change.0"),
            '{"id":0,"kind":0,"change":"Daily limit for ETH: 5 ETH","status":"cancelled","readyAt":0,"expiresAt":0}'
        );
        assertEq(rule("dailyLimit.ETH"), "1 ETH");
    }

    function test_TighteningAppearsAtOnce() public {
        vm.startPrank(rulesKey);
        vault.setDailyLimit(address(0), 0.5 ether);
        vault.setTradeTolerance(150);
        vm.stopPrank();
        assertEq(rule("dailyLimit.ETH"), "0.5 ETH");
        assertEq(rule("tradeTolerance"), "1.5%");
    }

    function test_ContactMoveAppearsInEns() public {
        vm.prank(rulesKey);
        IPermissionedResolver(userResolver).setAddress(dns(userSubname("ravi")), ETH_COIN_TYPE, abi.encodePacked(raviNew));
        vm.prank(everydayKey);
        uint256 id = vault.propose(VerbatimVault.ChangeKind.ContactAddress, ravi, address(0), uint256(uint160(raviNew)));
        string memory change = string.concat(userSubname("ravi"), " moves to ", vm.toLowercase(vm.toString(raviNew)));
        assertEq(
            rule("change.0"),
            string.concat('{"id":0,"kind":9,"change":"', change, '","status":"proposed","readyAt":0,"expiresAt":0}')
        );
        vm.prank(rulesKey);
        vault.approve(id);
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        vault.switchOn(id);
        assertEq(rule(string.concat("contact.", userSubname("ravi"))), vm.toLowercase(vm.toString(raviNew)));
    }

    function test_Gas() public {
        vm.prank(rulesKey);
        vault.setDailyLimit(address(0), 0.9 ether);
        uint256 published = vm.lastFrameGas().gasTotalUsed;
        VerbatimVault plain = newVault();
        vm.prank(rulesKey);
        plain.setDailyLimit(address(0), 1 ether);
        vm.prank(rulesKey);
        plain.setDailyLimit(address(0), 0.9 ether);
        uint256 unpublished = vm.lastFrameGas().gasTotalUsed;
        uint256 id = proposeLimit(2 ether);
        uint256 proposeGas = vm.lastFrameGas().gasTotalUsed;
        vm.prank(rulesKey);
        vault.approve(id);
        uint256 approveGas = vm.lastFrameGas().gasTotalUsed;
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        vault.switchOn(id);
        uint256 switchOnGas = vm.lastFrameGas().gasTotalUsed;
        console.log("Tighten a rule, published to ENS:", published);
        console.log("Tighten a rule, no ENS name:", unpublished);
        console.log("Propose a change, published:", proposeGas);
        console.log("Approve it, published:", approveGas);
        console.log("Switch it on, published:", switchOnGas);
    }
}

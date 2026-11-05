// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {VerbatimVault} from "../src/VerbatimVault.sol";
import {VerbatimPrints} from "../experiments/VerbatimPrints.sol";
import {TestDirectory} from "./TestDirectory.sol";
import {TestToken} from "./TestToken.sol";
import {TestPriceSource} from "./TestPriceSource.sol";

contract Forwarder {
    function forward(address to) external payable {
        (bool ok,) = to.call{value: msg.value}("");
        require(ok);
    }
}

contract LyingItem {
    uint256 calls;

    function balanceOf(address) external returns (uint256) {
        return ++calls;
    }
}

contract ReentrantItem {
    VerbatimVault public vault;

    function setVault(VerbatimVault target) external {
        vault = target;
    }

    function buy() external payable {
        VerbatimVault.Action[] memory none = new VerbatimVault.Action[](0);
        VerbatimVault.Check[] memory noChecks = new VerbatimVault.Check[](0);
        vault.run(none, noChecks, block.timestamp);
    }
}

contract MintAttacksTest is Test {
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant ETH = address(0);
    uint256 constant PRICE = 0.0001 ether;
    bytes32 constant ROOT = keccak256("picture");

    VerbatimVault vault;
    VerbatimPrints prints;
    TestToken usdc;
    Forwarder forwarder;
    ReentrantItem reentrant;
    address everydayKey = makeAddr("everydayKey");
    address rulesKey = makeAddr("rulesKey");
    address payee = makeAddr("payee");
    address thief = makeAddr("thief");
    address mom = makeAddr("mom");

    function setUp() public {
        vm.etch(PERMIT2, vm.parseJsonBytes(vm.readFile("test/fixtures/permit2-sepolia.json"), ".code"));
        usdc = new TestToken();
        prints = new VerbatimPrints(PRICE, payee);
        forwarder = new Forwarder();
        reentrant = new ReentrantItem();
        TestPriceSource prices = new TestPriceSource();
        prices.setPrice(address(usdc), 1e6, 1e6);
        prices.setPrice(ETH, 1 ether, 50_000e6);
        address[] memory trusted = new address[](3);
        trusted[0] = address(prints);
        trusted[1] = address(forwarder);
        trusted[2] = address(reentrant);
        address[] memory watched = new address[](1);
        watched[0] = address(usdc);
        vault = new VerbatimVault(everydayKey, rulesKey, watched, address(new TestDirectory(trusted)));
        reentrant.setVault(vault);
        usdc.mint(address(vault), 1000e6);
        vm.deal(address(vault), 1 ether);
        vm.startPrank(rulesKey);
        vault.saveContact(mom);
        vault.setDailyLimit(address(usdc), 1000e6);
        vault.setDailyLimit(ETH, 0.1 ether);
        vault.setNewContactLimit(address(usdc), 1000e6);
        vault.setPriceSource(address(prices));
        vault.finishSetup();
        vm.stopPrank();
        vm.warp(vm.getBlockTimestamp() + 2 days);
        honestMint();
    }

    function act(address target, uint256 value, bytes memory data) internal pure returns (VerbatimVault.Action memory) {
        return VerbatimVault.Action(target, value, data, 0);
    }

    function run(VerbatimVault.Action[] memory actions, VerbatimVault.Check[] memory checks) internal {
        vm.prank(everydayKey);
        vault.run(actions, checks, vm.getBlockTimestamp());
    }

    function buyChecks(uint256 cap, address item) internal pure returns (VerbatimVault.Check[] memory checks) {
        checks = new VerbatimVault.Check[](2);
        checks[0] = VerbatimVault.Check(VerbatimVault.CheckKind.AtMostLeaves, ETH, address(0), cap);
        checks[1] = VerbatimVault.Check(VerbatimVault.CheckKind.AtLeastArrives, item, address(0), 1);
    }

    function honestMint() internal {
        VerbatimVault.Action[] memory actions = new VerbatimVault.Action[](1);
        actions[0] = act(address(prints), PRICE, abi.encodeCall(VerbatimPrints.mint, (address(vault), ROOT)));
        run(actions, buyChecks(PRICE, address(prints)));
    }

    function payMomPlus(VerbatimVault.Action memory extra) internal {
        VerbatimVault.Action[] memory actions = new VerbatimVault.Action[](2);
        actions[0] = act(address(usdc), 0, abi.encodeCall(TestToken.transfer, (mom, 1e6)));
        actions[1] = extra;
        VerbatimVault.Check[] memory checks = new VerbatimVault.Check[](2);
        checks[0] = VerbatimVault.Check(VerbatimVault.CheckKind.AtMostLeaves, address(usdc), address(0), 1e6);
        checks[1] = VerbatimVault.Check(VerbatimVault.CheckKind.ExactlyTo, address(usdc), mom, 1e6);
        run(actions, checks);
    }

    function test_PaymentsStillWork() public {
        VerbatimVault.Action[] memory actions = new VerbatimVault.Action[](1);
        actions[0] = act(address(usdc), 0, abi.encodeCall(TestToken.transfer, (mom, 1e6)));
        VerbatimVault.Check[] memory checks = new VerbatimVault.Check[](2);
        checks[0] = VerbatimVault.Check(VerbatimVault.CheckKind.AtMostLeaves, address(usdc), address(0), 1e6);
        checks[1] = VerbatimVault.Check(VerbatimVault.CheckKind.ExactlyTo, address(usdc), mom, 1e6);
        run(actions, checks);
        assertEq(usdc.balanceOf(mom), 1e6);
    }

    function test_AHiddenPrintTransferIsRefused() public {
        vm.expectRevert("This kind of action isn't allowed");
        payMomPlus(act(address(prints), 0, abi.encodeCall(VerbatimPrints.transferFrom, (address(vault), thief, 1))));
        assertEq(prints.ownerOf(1), address(vault));
    }

    function test_AHiddenSafePrintTransferIsRefused() public {
        vm.expectRevert("This kind of action isn't allowed");
        payMomPlus(act(address(prints), 0, abi.encodeWithSignature("safeTransferFrom(address,address,uint256)", address(vault), thief, 1)));
        vm.expectRevert("This kind of action isn't allowed");
        payMomPlus(
            act(address(prints), 0, abi.encodeWithSignature("safeTransferFrom(address,address,uint256,bytes)", address(vault), thief, 1, ""))
        );
    }

    function test_AHiddenApprovalForAllPrintsIsRefused() public {
        vm.expectRevert("This kind of action isn't allowed");
        payMomPlus(act(address(prints), 0, abi.encodeCall(VerbatimPrints.setApprovalForAll, (thief, true))));
        assertFalse(prints.isApprovedForAll(address(vault), thief));
    }

    function test_AHiddenApprovalForOnePrintIsRefused() public {
        vm.expectRevert("This kind of action isn't allowed");
        payMomPlus(act(address(prints), 0, abi.encodeCall(VerbatimPrints.approve, (thief, 1))));
    }

    function test_AHiddenTokenTransferThroughATrustedContractIsRefused() public {
        vm.expectRevert("This kind of action isn't allowed");
        payMomPlus(act(address(forwarder), 0, abi.encodeWithSignature("transfer(address,uint256)", thief, 1)));
    }

    function test_MoneyLeftUnderTheCapCantGoElsewhere() public {
        VerbatimVault.Action[] memory actions = new VerbatimVault.Action[](2);
        actions[0] = act(address(prints), PRICE, abi.encodeCall(VerbatimPrints.mint, (address(vault), ROOT)));
        actions[1] = act(address(forwarder), 0.0009 ether, abi.encodeCall(Forwarder.forward, (thief)));
        vm.expectRevert("Unfair trade");
        run(actions, buyChecks(0.001 ether, address(prints)));
        assertEq(thief.balance, 0);
    }

    function test_OverpayingTheSellerStaysWithinYourCap() public {
        uint256 before = address(vault).balance;
        VerbatimVault.Action[] memory actions = new VerbatimVault.Action[](1);
        actions[0] = act(address(prints), 0.001 ether, abi.encodeCall(VerbatimPrints.mint, (address(vault), ROOT)));
        run(actions, buyChecks(0.001 ether, address(prints)));
        assertEq(before - address(vault).balance, 0.001 ether);
        assertEq(prints.balanceOf(address(vault)), 2);
    }

    function test_ALyingItemCantReleaseTheMoney() public {
        LyingItem liar = new LyingItem();
        VerbatimVault.Action[] memory actions = new VerbatimVault.Action[](1);
        actions[0] = act(address(forwarder), 0.001 ether, abi.encodeCall(Forwarder.forward, (thief)));
        vm.expectRevert();
        run(actions, buyChecks(0.001 ether, address(liar)));
        assertEq(thief.balance, 0);
    }

    function test_AnItemCantReenterTheVault() public {
        VerbatimVault.Action[] memory actions = new VerbatimVault.Action[](1);
        actions[0] = act(address(reentrant), PRICE, abi.encodeCall(ReentrantItem.buy, ()));
        vm.expectRevert("An action failed");
        run(actions, buyChecks(PRICE, address(prints)));
    }
}

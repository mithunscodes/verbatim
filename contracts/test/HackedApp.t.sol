// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {VerbatimVault, IPermit2} from "../src/VerbatimVault.sol";
import {TestToken} from "./TestToken.sol";
import {TestRouter} from "./TestRouter.sol";

contract HackedAppTest is Test {
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant ETH = address(0);
    uint256 constant FAIR_ETH = 0.0001 ether;

    VerbatimVault vault;
    TestToken usdc;
    TestToken dai;
    TestRouter router;
    address everydayKey = makeAddr("everydayKey");
    address rulesKey = makeAddr("rulesKey");
    address mom = makeAddr("mom");
    address thief = makeAddr("thief");
    uint256 deadline;

    function setUp() public {
        vm.etch(PERMIT2, vm.parseJsonBytes(vm.readFile("test/fixtures/permit2-sepolia.json"), ".code"));
        usdc = new TestToken();
        dai = new TestToken();
        router = new TestRouter();
        address[] memory watched = new address[](2);
        watched[0] = address(usdc);
        watched[1] = address(dai);
        address[] memory trusted = new address[](1);
        trusted[0] = address(router);
        vault = new VerbatimVault(everydayKey, rulesKey, watched, trusted);
        usdc.mint(address(vault), 100e6);
        dai.mint(address(vault), 100e18);
        vm.deal(address(vault), 1 ether);
        vm.deal(address(router), 10 ether);
        deadline = block.timestamp + 5 minutes;
    }

    function act(address target, bytes memory data) internal pure returns (VerbatimVault.Action memory) {
        return VerbatimVault.Action(target, 0, data, 0);
    }

    function approveToPermit2(uint256 amount) internal view returns (VerbatimVault.Action memory) {
        return act(address(usdc), abi.encodeCall(TestToken.approve, (PERMIT2, amount)));
    }

    function permit2ToRouter(uint160 amount) internal view returns (VerbatimVault.Action memory) {
        return act(PERMIT2, abi.encodeCall(IPermit2.approve, (address(usdc), address(router), amount, uint48(block.timestamp))));
    }

    function swap(uint160 amountIn) internal view returns (VerbatimVault.Action memory) {
        return act(address(router), abi.encodeCall(TestRouter.swap, (address(usdc), amountIn, FAIR_ETH)));
    }

    function sendUsdc(address to, uint256 amount) internal view returns (VerbatimVault.Action memory) {
        return act(address(usdc), abi.encodeCall(TestToken.transfer, (to, amount)));
    }

    function honestActions() internal view returns (VerbatimVault.Action[] memory actions) {
        actions = new VerbatimVault.Action[](4);
        actions[0] = approveToPermit2(5e6);
        actions[1] = permit2ToRouter(5e6);
        actions[2] = swap(5e6);
        actions[3] = sendUsdc(mom, 2e6);
    }

    function yourChecks() internal view returns (VerbatimVault.Check[] memory checks) {
        checks = new VerbatimVault.Check[](3);
        checks[0] = VerbatimVault.Check(VerbatimVault.CheckKind.AtMostLeaves, address(usdc), address(0), 7e6);
        checks[1] = VerbatimVault.Check(VerbatimVault.CheckKind.AtLeastArrives, ETH, address(0), FAIR_ETH);
        checks[2] = VerbatimVault.Check(VerbatimVault.CheckKind.ExactlyTo, address(usdc), mom, 2e6);
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

    function failure(uint256 checkNumber, string memory check, uint256 expected, uint256 actual)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeWithSelector(VerbatimVault.CheckFailed.selector, checkNumber, check, expected, actual);
    }

    function runWithYourChecks(VerbatimVault.Action[] memory actions) internal {
        vm.prank(everydayKey);
        vault.run(actions, yourChecks(), deadline);
    }

    function assertNothingMoved() internal view {
        assertEq(usdc.balanceOf(address(vault)), 100e6);
        assertEq(dai.balanceOf(address(vault)), 100e18);
        assertEq(address(vault).balance, 1 ether);
        assertEq(usdc.balanceOf(mom), 0);
        assertEq(usdc.balanceOf(thief), 0);
        assertEq(dai.balanceOf(thief), 0);
        assertEq(thief.balance, 0);
        assertEq(usdc.allowance(address(vault), PERMIT2), 0);
        (uint160 permit2Left,,) = IPermit2(PERMIT2).allowance(address(vault), address(usdc), address(router));
        assertEq(permit2Left, 0);
    }

    function test_Honest_Passes() public {
        runWithYourChecks(honestActions());
        assertEq(usdc.balanceOf(address(vault)), 93e6);
        assertEq(address(vault).balance, 1 ether + FAIR_ETH);
        assertEq(usdc.balanceOf(mom), 2e6);
        assertEq(usdc.allowance(address(vault), PERMIT2), 0);
    }

    function test_Hacked1_HiddenExtraTransfer() public {
        vm.expectRevert(failure(1, "At most X leaves", 7e6, 10e6));
        runWithYourChecks(plus(honestActions(), sendUsdc(thief, 3e6)));
        assertNothingMoved();
    }

    function test_Hacked1b_HiddenTransferOfATokenYouNeverMentioned() public {
        VerbatimVault.Action memory hidden = act(address(dai), abi.encodeCall(TestToken.transfer, (thief, 100e18)));
        vm.expectRevert("Something else would leave your account");
        runWithYourChecks(plus(honestActions(), hidden));
        assertNothingMoved();
    }

    function test_Hacked2_BiggerAmount() public {
        VerbatimVault.Action[] memory actions = honestActions();
        actions[0] = approveToPermit2(50e6);
        actions[1] = permit2ToRouter(50e6);
        actions[2] = swap(50e6);
        vm.expectRevert(failure(1, "At most X leaves", 7e6, 52e6));
        runWithYourChecks(actions);
        assertNothingMoved();
    }

    function test_Hacked3_PermissionLeftBehind() public {
        VerbatimVault.Action[] memory actions = honestActions();
        actions[0] = approveToPermit2(type(uint256).max);
        actions[1] = permit2ToRouter(type(uint160).max);
        vm.expectRevert("Permission left behind");
        runWithYourChecks(actions);
        assertNothingMoved();
    }

    function test_Hacked4_BybitBorrowedCodeTrick() public {
        VerbatimVault.Action[] memory actions = honestActions();
        actions[2] = VerbatimVault.Action(thief, 0, abi.encodeCall(TestToken.transfer, (thief, 0)), 1);
        vm.expectRevert("Borrowed code would run in your account");
        runWithYourChecks(actions);
        assertNothingMoved();
    }

    function test_Hacked5_SwapOutputSentSomewhereElse() public {
        VerbatimVault.Action[] memory actions = honestActions();
        actions[2] = act(address(router), abi.encodeCall(TestRouter.swapTo, (address(usdc), 5e6, FAIR_ETH, thief)));
        vm.expectRevert(failure(2, "At least Y arrives", FAIR_ETH, 0));
        runWithYourChecks(actions);
        assertNothingMoved();
    }

    function test_Hacked5b_PaymentToMomSentToTheThief() public {
        VerbatimVault.Action[] memory actions = honestActions();
        actions[3] = sendUsdc(thief, 2e6);
        vm.expectRevert(failure(3, "Exactly X to this address", 2e6, 0));
        runWithYourChecks(actions);
        assertNothingMoved();
    }
}

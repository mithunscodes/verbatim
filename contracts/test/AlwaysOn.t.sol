// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {VerbatimVault, IPermit2} from "../src/VerbatimVault.sol";
import {TestToken} from "./TestToken.sol";
import {TestRouter, IPermit2Pull} from "./TestRouter.sol";
import {LeakyVault} from "./LeakyVault.sol";

interface ISignatureTransfer {
    struct TokenPermissions {
        address token;
        uint256 amount;
    }

    struct PermitTransferFrom {
        TokenPermissions permitted;
        uint256 nonce;
        uint256 deadline;
    }

    struct SignatureTransferDetails {
        address to;
        uint256 requestedAmount;
    }

    function DOMAIN_SEPARATOR() external view returns (bytes32);

    function permitTransferFrom(
        PermitTransferFrom memory permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes calldata signature
    ) external;
}

contract AlwaysOnTest is Test {
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant ETH = address(0);
    bytes32 constant TOKEN_PERMISSIONS_TYPEHASH = keccak256("TokenPermissions(address token,uint256 amount)");
    bytes32 constant PERMIT_TRANSFER_FROM_TYPEHASH = keccak256(
        "PermitTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline)TokenPermissions(address token,uint256 amount)"
    );

    VerbatimVault vault;
    TestToken usdc;
    TestToken dai;
    TestRouter router;
    TestRouter fakeRouter;
    address everydayKey;
    uint256 everydayPrivateKey;
    address rulesKey = makeAddr("rulesKey");
    address mom = makeAddr("mom");
    address thief = makeAddr("thief");
    uint256 deadline;

    function setUp() public {
        vm.etch(PERMIT2, vm.parseJsonBytes(vm.readFile("test/fixtures/permit2-sepolia.json"), ".code"));
        (everydayKey, everydayPrivateKey) = makeAddrAndKey("everydayKey");
        usdc = new TestToken();
        dai = new TestToken();
        router = new TestRouter();
        fakeRouter = new TestRouter();
        vault = new VerbatimVault(everydayKey, rulesKey, tokens(), list(address(router)));
        usdc.mint(address(vault), 100e6);
        dai.mint(address(vault), 100e18);
        vm.deal(address(vault), 1 ether);
        vm.deal(address(router), 10 ether);
        vm.deal(address(fakeRouter), 10 ether);
        vm.startPrank(rulesKey);
        vault.saveContact(mom);
        vault.saveContact(thief);
        vm.stopPrank();
        deadline = block.timestamp + 5 minutes;
    }

    function list(address item) internal pure returns (address[] memory items) {
        items = new address[](1);
        items[0] = item;
    }

    function tokens() internal view returns (address[] memory items) {
        items = new address[](2);
        items[0] = address(usdc);
        items[1] = address(dai);
    }

    function act(address target, bytes memory data) internal pure returns (VerbatimVault.Action memory) {
        return VerbatimVault.Action(target, 0, data, 0);
    }

    function only(VerbatimVault.Action memory action) internal pure returns (VerbatimVault.Action[] memory actions) {
        actions = new VerbatimVault.Action[](1);
        actions[0] = action;
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

    function noChecks() internal pure returns (VerbatimVault.Check[] memory) {
        return new VerbatimVault.Check[](0);
    }

    function limit(address token, uint256 amount) internal pure returns (VerbatimVault.Check[] memory checks) {
        checks = new VerbatimVault.Check[](1);
        checks[0] = VerbatimVault.Check(VerbatimVault.CheckKind.AtMostLeaves, token, address(0), amount);
    }

    function swapChecks() internal view returns (VerbatimVault.Check[] memory checks) {
        checks = new VerbatimVault.Check[](2);
        checks[0] = VerbatimVault.Check(VerbatimVault.CheckKind.AtMostLeaves, address(usdc), address(0), 5e6);
        checks[1] = VerbatimVault.Check(VerbatimVault.CheckKind.AtLeastArrives, ETH, address(0), 0.0001 ether);
    }

    function permit2Swap(uint256 toPermit2, uint160 toRouter, uint160 used)
        internal
        view
        returns (VerbatimVault.Action[] memory actions)
    {
        actions = new VerbatimVault.Action[](3);
        actions[0] = act(address(usdc), abi.encodeCall(TestToken.approve, (PERMIT2, toPermit2)));
        actions[1] = act(
            PERMIT2, abi.encodeCall(IPermit2.approve, (address(usdc), address(router), toRouter, uint48(block.timestamp)))
        );
        actions[2] = act(address(router), abi.encodeCall(TestRouter.swap, (address(usdc), used, 0.0001 ether)));
    }

    function runAsEverydayKey(VerbatimVault.Action[] memory actions, VerbatimVault.Check[] memory checks) internal {
        vm.prank(everydayKey);
        vault.run(actions, checks, deadline);
    }

    function permit2Allowance() internal view returns (uint160 amount) {
        (amount,,) = IPermit2(PERMIT2).allowance(address(vault), address(usdc), address(router));
    }

    function signedPull(address spender, uint256 amount)
        internal
        view
        returns (ISignatureTransfer.PermitTransferFrom memory permit, bytes memory signature)
    {
        permit = ISignatureTransfer.PermitTransferFrom(
            ISignatureTransfer.TokenPermissions(address(usdc), amount), 0, block.timestamp + 1 hours
        );
        bytes32 tokenPermissions = keccak256(abi.encode(TOKEN_PERMISSIONS_TYPEHASH, permit.permitted));
        bytes32 structHash =
            keccak256(abi.encode(PERMIT_TRANSFER_FROM_TYPEHASH, tokenPermissions, spender, permit.nonce, permit.deadline));
        bytes32 digest =
            keccak256(abi.encodePacked("\x19\x01", ISignatureTransfer(PERMIT2).DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(everydayPrivateKey, digest);
        signature = abi.encodePacked(r, s, v);
    }

    function test_HonestPermit2SwapPassesEveryAlwaysOnCheck() public {
        runAsEverydayKey(permit2Swap(5e6, 5e6, 5e6), swapChecks());
        assertEq(usdc.allowance(address(vault), PERMIT2), 0);
        assertEq(permit2Allowance(), 0);
        assertEq(usdc.balanceOf(address(vault)), 95e6);
        assertEq(dai.balanceOf(address(vault)), 100e18);
        assertEq(address(vault).balance, 1.0001 ether);
    }

    function test_PermissionLeftBehind_Permit2AllowanceAboveZero() public {
        vm.expectRevert("Permission left behind");
        runAsEverydayKey(permit2Swap(5e6, 6e6, 5e6), swapChecks());
        assertEq(permit2Allowance(), 0);
        assertEq(usdc.balanceOf(address(vault)), 100e6);
    }

    function test_PermissionLeftBehind_TokenApprovalAboveZero() public {
        vm.expectRevert("Permission left behind");
        runAsEverydayKey(permit2Swap(6e6, 5e6, 5e6), swapChecks());
        assertEq(usdc.allowance(address(vault), PERMIT2), 0);
        assertEq(usdc.balanceOf(address(vault)), 100e6);
    }

    function test_NoBorrowedCode_NormalActionPasses() public {
        runAsEverydayKey(only(VerbatimVault.Action(mom, 0.1 ether, "", 0)), limit(ETH, 0.1 ether));
        assertEq(mom.balance, 0.1 ether);
    }

    function test_NoBorrowedCode_Refused() public {
        VerbatimVault.Action memory action = act(thief, abi.encodeCall(TestToken.transfer, (thief, 0)));
        action.operation = 1;
        vm.expectRevert("Borrowed code would run in your account");
        runAsEverydayKey(only(action), noChecks());
    }

    function test_AccountUnchanged_HonestRunPasses() public {
        LeakyVault leaky = new LeakyVault(everydayKey, rulesKey, tokens());
        vm.deal(address(leaky), 1 ether);
        vm.prank(rulesKey);
        leaky.saveContact(mom);
        vm.prank(everydayKey);
        leaky.run(only(VerbatimVault.Action(mom, 0.1 ether, "", 0)), limit(ETH, 0.1 ether), deadline);
        assertEq(mom.balance, 0.1 ether);
        assertEq(leaky.everydayKey(), everydayKey);
    }

    function test_AccountUnchanged_KeyChangeRefused() public {
        LeakyVault leaky = new LeakyVault(everydayKey, rulesKey, tokens());
        VerbatimVault.Action memory takeover = act(address(leaky), abi.encodeCall(LeakyVault.setEverydayKey, (thief)));
        vm.prank(everydayKey);
        vm.expectRevert("Your account would change");
        leaky.run(only(takeover), noChecks(), deadline);
        assertEq(leaky.everydayKey(), everydayKey);
    }

    function test_KnownDoors_PlainTransferToSavedContactPasses() public {
        runAsEverydayKey(only(VerbatimVault.Action(mom, 0.1 ether, "", 0)), limit(ETH, 0.1 ether));
        assertEq(mom.balance, 0.1 ether);
    }

    function test_KnownDoors_UntrustedContractRefused() public {
        VerbatimVault.Action memory action =
            act(address(fakeRouter), abi.encodeCall(TestRouter.swap, (address(usdc), 5e6, 0.0001 ether)));
        vm.expectRevert("Not a trusted contract");
        runAsEverydayKey(only(action), swapChecks());
    }

    function test_AllowedKinds_TokenPermissionForUntrustedContractRefused() public {
        vm.expectRevert("Permission for an untrusted contract");
        runAsEverydayKey(only(act(address(usdc), abi.encodeCall(TestToken.approve, (thief, 5e6)))), noChecks());
    }

    function test_AllowedKinds_Permit2PermissionForUntrustedContractRefused() public {
        bytes memory data = abi.encodeCall(IPermit2.approve, (address(usdc), thief, 5e6, uint48(block.timestamp)));
        vm.expectRevert("Permission for an untrusted contract");
        runAsEverydayKey(only(act(PERMIT2, data)), noChecks());
    }

    function test_AllowedKinds_OtherTokenActionsRefused() public {
        vm.expectRevert("This kind of action isn't allowed");
        runAsEverydayKey(only(act(address(usdc), abi.encodeCall(TestToken.transferFrom, (mom, thief, 1)))), noChecks());
    }

    function test_AllowedKinds_OtherPermit2ActionsRefused() public {
        bytes memory data = abi.encodeCall(IPermit2Pull.transferFrom, (address(vault), thief, 5e6, address(usdc)));
        vm.expectRevert("This kind of action isn't allowed");
        runAsEverydayKey(only(act(PERMIT2, data)), noChecks());
    }

    function test_NothingElseLeaves_LimitLetsATokenLeave() public {
        runAsEverydayKey(only(act(address(dai), abi.encodeCall(TestToken.transfer, (mom, 10e18)))), limit(address(dai), 10e18));
        assertEq(dai.balanceOf(mom), 10e18);
    }

    function test_NothingElseLeaves_HiddenTokenTransferRefused() public {
        VerbatimVault.Action memory hidden = act(address(dai), abi.encodeCall(TestToken.transfer, (thief, 10e18)));
        vm.expectRevert("Something else would leave your account");
        runAsEverydayKey(plus(permit2Swap(5e6, 5e6, 5e6), hidden), swapChecks());
        assertEq(dai.balanceOf(thief), 0);
    }

    function test_NothingElseLeaves_HiddenEthTransferRefused() public {
        VerbatimVault.Action memory hidden = VerbatimVault.Action(thief, 0.5 ether, "", 0);
        vm.expectRevert("Something else would leave your account");
        runAsEverydayKey(plus(permit2Swap(5e6, 5e6, 5e6), hidden), limit(address(usdc), 5e6));
        assertEq(thief.balance, 0);
    }

    function test_NeverSigns_AnswersInvalidEvenForItsOwnKey() public view {
        (, bytes memory signature) = signedPull(thief, 100e6);
        assertEq(vault.isValidSignature(keccak256("anything"), signature), bytes4(0xffffffff));
    }

    function test_NeverSigns_SignedPermit2PullFails() public {
        vm.prank(address(vault));
        usdc.approve(PERMIT2, 100e6);
        (ISignatureTransfer.PermitTransferFrom memory permit, bytes memory signature) =
            signedPull(thief, 100e6);
        vm.prank(thief);
        vm.expectRevert(bytes4(keccak256("InvalidContractSignature()")));
        ISignatureTransfer(PERMIT2).permitTransferFrom(
            permit, ISignatureTransfer.SignatureTransferDetails(thief, 100e6), address(vault), signature
        );
        assertEq(usdc.balanceOf(address(vault)), 100e6);
        assertEq(usdc.balanceOf(thief), 0);
    }

    function test_NeverSigns_SameSignedPullWorksOnAnOrdinaryWallet() public {
        usdc.mint(everydayKey, 100e6);
        vm.prank(everydayKey);
        usdc.approve(PERMIT2, 100e6);
        (ISignatureTransfer.PermitTransferFrom memory permit, bytes memory signature) =
            signedPull(thief, 100e6);
        vm.prank(thief);
        ISignatureTransfer(PERMIT2).permitTransferFrom(
            permit, ISignatureTransfer.SignatureTransferDetails(thief, 100e6), everydayKey, signature
        );
        assertEq(usdc.balanceOf(thief), 100e6);
    }
}

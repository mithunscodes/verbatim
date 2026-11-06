// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console} from "forge-std/console.sol";
import {VerbatimVault, IPermit2} from "../src/VerbatimVault.sol";
import {EnsDirectory, IUniversalResolver, IVerifiableFactory} from "../src/EnsDirectory.sol";
import {EnsSettings} from "../script/EnsSettings.sol";
import {TestDirectory} from "./TestDirectory.sol";
import {DirectoryFork, IPermissionedResolver, IProxyFactory} from "./DirectoryFork.sol";

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface IWeth {
    function deposit() external payable;
}

contract FakeResolver {
    address immutable answer;

    constructor(address answer_) {
        answer = answer_;
    }

    function resolve(bytes calldata, bytes calldata) external view returns (bytes memory) {
        return abi.encode(abi.encodePacked(answer));
    }

    function supportsInterface(bytes4) external pure returns (bool) {
        return true;
    }
}

contract EnsDirectoryTest is DirectoryFork {
    address everydayKey = makeAddr("everydayKey");
    address rulesKey = makeAddr("rulesKey");
    address mom = makeAddr("mom");
    EnsDirectory directory;
    VerbatimVault vault;

    function setUp() public {
        if (!buildDirectory()) return;
        directory = EnsSettings.deployDirectory();
        vault = newVault(address(directory));
    }

    function newVault(address directory_) internal returns (VerbatimVault fresh) {
        fresh = new VerbatimVault(everydayKey, rulesKey, accounts(USDC), directory_);
        vm.deal(address(fresh), 1 ether);
        vm.startPrank(rulesKey);
        fresh.saveContact(mom);
        fresh.setDailyLimit(address(0), 1 ether);
        fresh.finishSetup();
        vm.stopPrank();
        vm.warp(vm.getBlockTimestamp() + 1 days);
    }

    function routerCall() internal view returns (VerbatimVault.Action[] memory actions) {
        actions = new VerbatimVault.Action[](1);
        actions[0] = VerbatimVault.Action(
            UNIVERSAL_ROUTER, 0, abi.encodeCall(IUniversalRouter.execute, ("", new bytes[](0), vm.getBlockTimestamp())), 0
        );
    }

    function permissionFor(address spender) internal pure returns (VerbatimVault.Action[] memory actions) {
        actions = new VerbatimVault.Action[](1);
        actions[0] = VerbatimVault.Action(PERMIT2, 0, abi.encodeCall(IPermit2.approve, (USDC, spender, 0, 0)), 0);
    }

    function call(address target, bytes memory data) internal pure returns (VerbatimVault.Action[] memory actions) {
        actions = new VerbatimVault.Action[](1);
        actions[0] = VerbatimVault.Action(target, 0, data, 0);
    }

    function payMom(uint256 amount) internal view returns (VerbatimVault.Action[] memory actions) {
        actions = new VerbatimVault.Action[](1);
        actions[0] = VerbatimVault.Action(mom, amount, "", 0);
    }

    function ethLimit(uint256 amount) internal pure returns (VerbatimVault.Check[] memory checks) {
        checks = new VerbatimVault.Check[](1);
        checks[0] = VerbatimVault.Check(VerbatimVault.CheckKind.AtMostLeaves, address(0), address(0), amount);
    }

    function run(VerbatimVault target, VerbatimVault.Action[] memory actions) internal {
        vm.prank(everydayKey);
        target.run(actions, new VerbatimVault.Check[](0), vm.getBlockTimestamp() + 1 hours);
    }

    function test_DirectoryReadsTheTrustedNames() public view {
        assertEq(directory.nameCount(), 2);
        assertEq(directory.names(0), nameOf("router", "uniswap"));
        assertEq(directory.names(1), nameOf("prints", "studio"));
        address[] memory listed = directory.listed();
        assertEq(listed.length, 1);
        assertEq(listed[0], UNIVERSAL_ROUTER);
        assertTrue(directory.isListed(UNIVERSAL_ROUTER));
        assertFalse(directory.isListed(PERMIT2));
        assertFalse(directory.isListed(address(0)));
    }

    function test_AddressOfReadsAnyDirectoryName() public view {
        assertEq(directory.addressOf(nameOf("router", "uniswap")), UNIVERSAL_ROUTER);
        assertEq(directory.addressOf(nameOf("permit2", "uniswap")), PERMIT2);
        assertEq(directory.addressOf(nameOf("usdc", "circle")), USDC);
    }

    function test_MissingNamesReadAsEmpty() public view {
        assertEq(directory.addressOf(nameOf("ghost", "uniswap")), address(0));
        assertEq(directory.addressOf(string.concat("uniswap.", EnsSettings.directoryName())), address(0));
        assertEq(directory.addressOf("nobody-registered-this-name.eth"), address(0));
    }

    function test_RevertWhen_NameIsBadlyFormed() public {
        vm.expectRevert("A name can't be empty");
        directory.addressOf("");
        vm.expectRevert("Each part of a name must be 1 to 63 characters");
        directory.addressOf("router..eth");
    }

    function test_KnownContract_Passes() public {
        run(vault, routerCall());
    }

    function test_KnownContract_PermissionPasses() public {
        run(vault, permissionFor(UNIVERSAL_ROUTER));
    }

    function test_RevertWhen_UnknownContract() public {
        vm.prank(everydayKey);
        vm.expectRevert("Not a trusted contract");
        vault.run(call(WETH, abi.encodeCall(IWeth.deposit, ())), new VerbatimVault.Check[](0), vm.getBlockTimestamp() + 1 hours);
    }

    function test_RevertWhen_PermissionForUnknownContract() public {
        vm.prank(everydayKey);
        vm.expectRevert("Permission for an untrusted contract");
        vault.run(permissionFor(WETH), new VerbatimVault.Check[](0), vm.getBlockTimestamp() + 1 hours);
    }

    function test_RevertWhen_ListedContractSavedAsContact() public {
        vm.prank(rulesKey);
        vm.expectRevert("A token or trusted contract can't be a contact");
        vault.saveContact(UNIVERSAL_ROUTER);
    }

    function test_VaultFollowsTheOrganizationsRecord() public {
        vm.prank(uniswapKey);
        IPermissionedResolver(uniswap.resolver).setAddress(
            dns(nameOf("router", "uniswap")), ETH_COIN_TYPE, abi.encodePacked(WETH)
        );
        vm.prank(everydayKey);
        vm.expectRevert("Not a trusted contract");
        vault.run(routerCall(), new VerbatimVault.Check[](0), vm.getBlockTimestamp() + 1 hours);
        run(vault, call(WETH, abi.encodeCall(IWeth.deposit, ())));
    }

    function test_RevertWhen_NamePointsToAFakeResolver() public {
        FakeResolver fake = new FakeResolver(UNIVERSAL_ROUTER);
        vm.prank(uniswapKey);
        uniswap.registry.setResolver(uint256(keccak256("router")), address(fake));
        assertEq(directory.addressOf(nameOf("router", "uniswap")), address(0));
        vm.prank(everydayKey);
        vm.expectRevert("Not a trusted contract");
        vault.run(routerCall(), new VerbatimVault.Check[](0), vm.getBlockTimestamp() + 1 hours);
    }

    function test_RevertWhen_ResolverRunsOtherCode() public {
        Grant[] memory grants = new Grant[](1);
        grants[0] = Grant(uniswapKey, ALL_ROLES);
        vm.startPrank(uniswapKey);
        address impostor = IProxyFactory(EnsSettings.VERIFIABLE_FACTORY).deployProxy(
            EnsSettings.USER_REGISTRY_IMPL, 1, abi.encodeWithSignature("initialize((address,uint256)[])", grants)
        );
        uniswap.registry.setResolver(uint256(keccak256("router")), impostor);
        vm.stopPrank();
        assertEq(directory.addressOf(nameOf("router", "uniswap")), address(0));
        vm.prank(everydayKey);
        vm.expectRevert("Not a trusted contract");
        vault.run(routerCall(), new VerbatimVault.Check[](0), vm.getBlockTimestamp() + 1 hours);
    }

    function test_ExpiredDirectoryClosesTheDoor() public {
        vm.warp(expiry + 1);
        assertEq(directory.addressOf(nameOf("router", "uniswap")), address(0));
        vm.prank(everydayKey);
        vm.expectRevert("Not a trusted contract");
        vault.run(routerCall(), new VerbatimVault.Check[](0), vm.getBlockTimestamp() + 1 hours);
    }

    function test_PlainPaymentDoesNotReadTheDirectory() public {
        vm.prank(everydayKey);
        vm.expectCall(address(directory), abi.encodeCall(EnsDirectory.listed, ()), 0);
        vault.run(payMom(0.1 ether), ethLimit(0.1 ether), vm.getBlockTimestamp() + 1 hours);
        assertEq(mom.balance, 0.1 ether);
    }

    function test_DirectoryIsReadOncePerRun() public {
        VerbatimVault.Action[] memory actions = new VerbatimVault.Action[](2);
        actions[0] = permissionFor(UNIVERSAL_ROUTER)[0];
        actions[1] = routerCall()[0];
        vm.expectCall(address(directory), abi.encodeCall(EnsDirectory.listed, ()), 1);
        run(vault, actions);
    }

    function test_Gas() public {
        VerbatimVault plain = newVault(address(new TestDirectory(accounts(UNIVERSAL_ROUTER))));
        vm.cool(address(vault));
        vm.cool(address(plain));

        directory.listed();
        uint256 readGas = vm.lastFrameGas().gasTotalUsed;

        vm.prank(everydayKey);
        vault.run(routerCall(), new VerbatimVault.Check[](0), vm.getBlockTimestamp() + 1 hours);
        uint256 ensRunGas = vm.lastFrameGas().gasTotalUsed;

        vm.prank(everydayKey);
        plain.run(routerCall(), new VerbatimVault.Check[](0), vm.getBlockTimestamp() + 1 hours);
        uint256 plainRunGas = vm.lastFrameGas().gasTotalUsed;

        vm.prank(everydayKey);
        vault.run(payMom(0.1 ether), ethLimit(0.1 ether), vm.getBlockTimestamp() + 1 hours);
        uint256 paymentGas = vm.lastFrameGas().gasTotalUsed;

        console.log("Read the directory (1 name):", readGas);
        console.log("Vault run calling the router, ENS directory:", ensRunGas);
        console.log("Same run, pretend directory without ENS:", plainRunGas);
        console.log("Extra cost of reading ENS in the run:", ensRunGas - plainRunGas);
        console.log("Plain ETH payment (no directory read):", paymentGas);
        assertLt(ensRunGas - plainRunGas, 150_000);
    }
}

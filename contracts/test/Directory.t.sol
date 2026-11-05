// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {EnsSettings} from "../script/EnsSettings.sol";
import {DirectoryFork, IRegistry, IPermissionedResolver} from "./DirectoryFork.sol";

contract DirectoryTest is DirectoryFork {
    address stranger = makeAddr("stranger");

    function setUp() public {
        buildDirectory();
    }

    function test_NamesResolveToTheRealContracts() public view {
        (address resolver, address record) = lookup(nameOf("router", "uniswap"));
        assertEq(record, UNIVERSAL_ROUTER);
        assertEq(resolver, uniswap.resolver);
        (resolver, record) = lookup(nameOf("permit2", "uniswap"));
        assertEq(record, PERMIT2);
        assertEq(resolver, uniswap.resolver);
        (resolver, record) = lookup(nameOf("usdc", "circle"));
        assertEq(record, USDC);
        assertEq(resolver, circle.resolver);
    }

    function test_EachOrganizationOwnsItsName() public view {
        assertEq(directoryRegistry.findOwner("uniswap"), uniswapKey);
        assertEq(directoryRegistry.findOwner("circle"), circleKey);
        assertEq(directoryRegistry.getSubregistry("uniswap"), address(uniswap.registry));
        assertEq(directoryRegistry.getSubregistry("circle"), address(circle.registry));
        assertEq(uniswap.registry.findOwner("router"), uniswapKey);
        assertEq(circle.registry.findOwner("usdc"), circleKey);
        assertEq(IRegistry(EnsSettings.ETH_REGISTRY).getSubregistry(EnsSettings.DIRECTORY_LABEL), address(directoryRegistry));
    }

    function test_OrganizationCanEditItsOwnRecords() public {
        address newRouter = makeAddr("newRouter");
        vm.prank(uniswapKey);
        IPermissionedResolver(uniswap.resolver).setAddress(
            dns(nameOf("router", "uniswap")), ETH_COIN_TYPE, abi.encodePacked(newRouter)
        );
        (, address record) = lookup(nameOf("router", "uniswap"));
        assertEq(record, newRouter);
    }

    function test_OrganizationCanAddItsOwnContracts() public {
        address quoter = makeAddr("quoter");
        vm.startPrank(uniswapKey);
        IPermissionedResolver(uniswap.resolver).setAddress(dns(nameOf("quoter", "uniswap")), ETH_COIN_TYPE, abi.encodePacked(quoter));
        uniswap.registry.register("quoter", uniswapKey, address(0), uniswap.resolver, ORGANIZATION_ROLES, expiry);
        vm.stopPrank();
        (, address record) = lookup(nameOf("quoter", "uniswap"));
        assertEq(record, quoter);
    }

    function test_RevertWhen_OrganizationEditsAnotherOrganizationsRecords() public {
        bytes memory router = dns(nameOf("router", "uniswap"));
        vm.prank(circleKey);
        vm.expectPartialRevert(UNAUTHORIZED);
        IPermissionedResolver(uniswap.resolver).setAddress(router, ETH_COIN_TYPE, abi.encodePacked(circleKey));
        vm.prank(stranger);
        vm.expectPartialRevert(UNAUTHORIZED);
        IPermissionedResolver(uniswap.resolver).setAddress(router, ETH_COIN_TYPE, abi.encodePacked(stranger));
        (, address record) = lookup(nameOf("router", "uniswap"));
        assertEq(record, UNIVERSAL_ROUTER);
    }

    function test_RevertWhen_OrganizationTakesOverAnotherOrganizationsName() public {
        uint256 uniswapName = uint256(keccak256("uniswap"));
        vm.startPrank(circleKey);
        vm.expectPartialRevert(UNAUTHORIZED);
        directoryRegistry.setResolver(uniswapName, circle.resolver);
        vm.expectPartialRevert(UNAUTHORIZED);
        directoryRegistry.setSubregistry(uniswapName, address(circle.registry));
        vm.expectPartialRevert(UNAUTHORIZED);
        uniswap.registry.register("fake", circleKey, address(0), circle.resolver, ORGANIZATION_ROLES, expiry);
        vm.expectPartialRevert(UNAUTHORIZED);
        uniswap.registry.setResolver(uint256(keccak256("router")), circle.resolver);
        vm.stopPrank();
        (address resolver, address record) = lookup(nameOf("router", "uniswap"));
        assertEq(resolver, uniswap.resolver);
        assertEq(record, UNIVERSAL_ROUTER);
    }

    function test_DirectoryCantOverrideOrganizations() public {
        uint256 uniswapName = uint256(keccak256("uniswap"));
        assertTrue(directoryRegistry.isEmancipated());
        vm.startPrank(builder);
        vm.expectPartialRevert(UNAUTHORIZED);
        directoryRegistry.setResolver(uniswapName, builder);
        vm.expectPartialRevert(UNAUTHORIZED);
        directoryRegistry.setSubregistry(uniswapName, builder);
        vm.expectPartialRevert(UNAUTHORIZED);
        directoryRegistry.unregister(uniswapName);
        vm.expectPartialRevert(CANNOT_GRANT);
        directoryRegistry.grantRootRoles(ROLE_SET_RESOLVER, builder);
        vm.expectPartialRevert(UNAUTHORIZED);
        directoryRegistry.setParent(builder, "moved");
        vm.expectPartialRevert(UNAUTHORIZED);
        IPermissionedResolver(uniswap.resolver).setAddress(
            dns(nameOf("router", "uniswap")), ETH_COIN_TYPE, abi.encodePacked(builder)
        );
        vm.stopPrank();
        assertEq(directoryRegistry.findOwner("uniswap"), uniswapKey);
    }

    function test_DirectoryCanAddANewOrganization() public {
        address aaveKey = makeAddr("aaveKey");
        Organization memory aave = setUpOrganization("aave", aaveKey, labels("pool"), accounts(makeAddr("aavePool")));
        assertEq(directoryRegistry.findOwner("aave"), aaveKey);
        (address resolver, address record) = lookup(nameOf("pool", "aave"));
        assertEq(resolver, aave.resolver);
        assertEq(record, makeAddr("aavePool"));
    }

    function test_RevertWhen_StrangerRegistersInTheDirectory() public {
        vm.prank(stranger);
        vm.expectPartialRevert(UNAUTHORIZED);
        directoryRegistry.register("uniswap2", stranger, address(0), address(0), ORGANIZATION_ROLES, expiry);
    }
}

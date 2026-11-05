// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {EnsSettings} from "../script/EnsSettings.sol";
import {IUniversalResolver, IExtendedResolver, IAddressResolver} from "../src/EnsDirectory.sol";

interface IMockUsdc {
    function mint(address to, uint256 amount) external;
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IEthRegistrar {
    function getRegisterPrice(string calldata label, uint64 duration, address paymentToken)
        external
        view
        returns (uint256 base, uint256 premium);
    function makeCommitment(
        string calldata label,
        address owner,
        bytes32 secret,
        address subregistry,
        address resolver,
        uint64 duration,
        bytes32 referrer
    ) external pure returns (bytes32);
    function commit(bytes32 commitment) external;
    function register(
        string calldata label,
        address owner,
        bytes32 secret,
        address subregistry,
        address resolver,
        uint64 duration,
        address paymentToken,
        bytes32 referrer
    ) external returns (uint256);
    function MIN_COMMITMENT_AGE() external view returns (uint64);
}

interface IRegistry {
    function register(string calldata label, address owner, address registry, address resolver, uint256 roleBitmap, uint64 expiry)
        external
        returns (uint256);
    function setParent(address parent, string calldata label) external;
    function setResolver(uint256 anyId, address resolver) external;
    function setSubregistry(uint256 anyId, address registry) external;
    function unregister(uint256 anyId) external;
    function grantRootRoles(uint256 roleBitmap, address account) external returns (bool);
    function revokeRootRoles(uint256 roleBitmap, address account) external returns (bool);
    function isEmancipated() external view returns (bool);
    function findExpiry(string calldata label) external view returns (uint64);
    function findOwner(string calldata label) external view returns (address);
    function getSubregistry(string calldata label) external view returns (address);
    function getResolver(string calldata label) external view returns (address);
}

interface IProxyFactory {
    function deployProxy(address implementation, uint256 salt, bytes calldata data) external returns (address);
}

interface IPermissionedResolver {
    function setAddress(bytes calldata name, uint256 coinType, bytes calldata addressBytes) external;
}

abstract contract DirectoryFork is Test {
    uint256 constant FORK_BLOCK = 11_924_691;
    uint256 constant ETH_COIN_TYPE = 60;
    uint64 constant ONE_YEAR = 365 days;

    uint256 constant ROLE_REGISTRAR = 1 << 0;
    uint256 constant ROLE_SET_PARENT = 1 << 8;
    uint256 constant ROLE_UNREGISTER = 1 << 12;
    uint256 constant ROLE_RENEW = 1 << 16;
    uint256 constant ROLE_SET_SUBREGISTRY = 1 << 20;
    uint256 constant ROLE_SET_RESOLVER = 1 << 24;
    uint256 constant ROLE_CAN_TRANSFER_ADMIN = (1 << 28) << 128;
    uint256 constant ALL_ROLES = 0x1111111111111111111111111111111111111111111111111111111111111111;
    uint256 constant OPERATOR_ROLES =
        ROLE_REGISTRAR | ROLE_RENEW | ROLE_SET_PARENT | ((ROLE_REGISTRAR | ROLE_RENEW | ROLE_SET_PARENT) << 128);
    uint256 constant ORGANIZATION_ROLES = ROLE_SET_RESOLVER | ROLE_SET_SUBREGISTRY
        | ((ROLE_SET_RESOLVER | ROLE_SET_SUBREGISTRY) << 128) | ROLE_CAN_TRANSFER_ADMIN;

    bytes4 constant UNAUTHORIZED = bytes4(keccak256("EACUnauthorizedAccountRoles(uint256,uint256,address)"));
    bytes4 constant CANNOT_GRANT = bytes4(keccak256("EACCannotGrantRoles(uint256,uint256,address)"));

    address constant UNIVERSAL_ROUTER = 0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant USDC = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238;
    address constant WETH = 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14;

    struct Grant {
        address account;
        uint256 roleBitmap;
    }

    struct Organization {
        address key;
        IRegistry registry;
        address resolver;
    }

    address builder = makeAddr("builder");
    address uniswapKey = makeAddr("uniswapKey");
    address circleKey = makeAddr("circleKey");
    IRegistry directoryRegistry;
    uint64 expiry;
    Organization uniswap;
    Organization circle;

    function buildDirectory() internal returns (bool) {
        string memory url = vm.envOr("SEPOLIA_RPC_URL", string(""));
        if (bytes(url).length == 0) {
            vm.skip(true);
            return false;
        }
        vm.createSelectFork(url, FORK_BLOCK);
        registerDirectoryName();
        uniswap = setUpOrganization("uniswap", uniswapKey, labels("router", "permit2"), accounts(UNIVERSAL_ROUTER, PERMIT2));
        circle = setUpOrganization("circle", circleKey, labels("usdc"), accounts(USDC));
        return true;
    }

    function registerDirectoryName() internal {
        string memory label = EnsSettings.DIRECTORY_LABEL;
        IEthRegistrar registrar = IEthRegistrar(EnsSettings.ETH_REGISTRAR);
        vm.startPrank(builder);
        address builderResolver = deployResolver(builder, new bytes[](0));
        directoryRegistry = deployRegistry(EnsSettings.directoryName(), builder, OPERATOR_ROLES);
        (uint256 base, uint256 premium) = registrar.getRegisterPrice(label, ONE_YEAR, EnsSettings.MOCK_USDC);
        IMockUsdc(EnsSettings.MOCK_USDC).mint(builder, base + premium);
        IMockUsdc(EnsSettings.MOCK_USDC).approve(address(registrar), base + premium);
        bytes32 secret = keccak256("secret");
        registrar.commit(
            registrar.makeCommitment(label, builder, secret, address(directoryRegistry), builderResolver, ONE_YEAR, bytes32(0))
        );
        vm.warp(block.timestamp + registrar.MIN_COMMITMENT_AGE() + 1);
        registrar.register(
            label, builder, secret, address(directoryRegistry), builderResolver, ONE_YEAR, EnsSettings.MOCK_USDC, bytes32(0)
        );
        directoryRegistry.setParent(EnsSettings.ETH_REGISTRY, label);
        directoryRegistry.revokeRootRoles(ROLE_SET_PARENT | (ROLE_SET_PARENT << 128), builder);
        vm.stopPrank();
        expiry = IRegistry(EnsSettings.ETH_REGISTRY).findExpiry(label);
    }

    function setUpOrganization(string memory label, address key, string[] memory contractLabels, address[] memory addresses)
        internal
        returns (Organization memory organization)
    {
        string memory name = string.concat(label, ".", EnsSettings.directoryName());
        bytes[] memory records = new bytes[](contractLabels.length);
        for (uint256 i = 0; i < contractLabels.length; i++) {
            string memory contractName = string.concat(contractLabels[i], ".", name);
            records[i] = abi.encodeCall(
                IPermissionedResolver.setAddress, (dns(contractName), ETH_COIN_TYPE, abi.encodePacked(addresses[i]))
            );
        }
        vm.startPrank(key);
        organization.key = key;
        organization.resolver = deployResolver(key, records);
        organization.registry = deployRegistry(name, key, ALL_ROLES);
        for (uint256 i = 0; i < contractLabels.length; i++) {
            organization.registry.register(contractLabels[i], key, address(0), organization.resolver, ORGANIZATION_ROLES, expiry);
        }
        organization.registry.setParent(address(directoryRegistry), label);
        vm.stopPrank();
        vm.prank(builder);
        directoryRegistry.register(
            label, key, address(organization.registry), organization.resolver, ORGANIZATION_ROLES, expiry
        );
    }

    function deployResolver(address owner, bytes[] memory records) internal returns (address) {
        Grant[] memory grants = new Grant[](1);
        grants[0] = Grant(owner, ALL_ROLES);
        uint256 salt = uint256(keccak256(abi.encode(keccak256("OwnedResolver"), owner, uint256(0))));
        return IProxyFactory(EnsSettings.VERIFIABLE_FACTORY).deployProxy(
            EnsSettings.PERMISSIONED_RESOLVER_IMPL,
            salt,
            abi.encodeWithSignature("initialize((address,uint256)[],bytes[])", grants, records)
        );
    }

    function deployRegistry(string memory name, address owner, uint256 roles) internal returns (IRegistry) {
        Grant[] memory grants = new Grant[](1);
        grants[0] = Grant(owner, roles);
        uint256 salt = uint256(keccak256(abi.encode(keccak256("UserRegistry"), vm.ensNamehash(name), uint256(0))));
        return IRegistry(
            IProxyFactory(EnsSettings.VERIFIABLE_FACTORY).deployProxy(
                EnsSettings.USER_REGISTRY_IMPL, salt, abi.encodeWithSignature("initialize((address,uint256)[])", grants)
            )
        );
    }

    function lookup(string memory name) internal view returns (address resolver, address record) {
        bytes memory encoded = dns(name);
        uint256 offset;
        bytes32 node;
        (resolver, node, offset) = IUniversalResolver(EnsSettings.UNIVERSAL_RESOLVER).findResolver(encoded);
        if (resolver == address(0) || offset != 0) return (resolver, address(0));
        bytes memory value = abi.decode(
            IExtendedResolver(resolver).resolve(encoded, abi.encodeCall(IAddressResolver.addr, (node, ETH_COIN_TYPE))),
            (bytes)
        );
        if (value.length == 20) record = address(bytes20(value));
    }

    function nameOf(string memory contractLabel, string memory organizationLabel) internal pure returns (string memory) {
        return string.concat(contractLabel, ".", organizationLabel, ".", EnsSettings.directoryName());
    }

    function dns(string memory name) internal pure returns (bytes memory encoded) {
        bytes memory text = bytes(name);
        encoded = new bytes(text.length + 2);
        uint256 start = 0;
        for (uint256 i = 0; i <= text.length; i++) {
            if (i < text.length && text[i] != ".") continue;
            encoded[start] = bytes1(uint8(i - start));
            for (uint256 j = start; j < i; j++) {
                encoded[j + 1] = text[j];
            }
            start = i + 1;
        }
    }

    function labels(string memory a) internal pure returns (string[] memory items) {
        items = new string[](1);
        items[0] = a;
    }

    function labels(string memory a, string memory b) internal pure returns (string[] memory items) {
        items = new string[](2);
        items[0] = a;
        items[1] = b;
    }

    function accounts(address a) internal pure returns (address[] memory items) {
        items = new address[](1);
        items[0] = a;
    }

    function accounts(address a, address b) internal pure returns (address[] memory items) {
        items = new address[](2);
        items[0] = a;
        items[1] = b;
    }
}

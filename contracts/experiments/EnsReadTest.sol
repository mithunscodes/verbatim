// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IUniversalResolverV2 {
    function findResolver(bytes calldata name) external view returns (address resolver, bytes32 node, uint256 offset);
}

interface IExtendedResolver {
    function resolve(bytes calldata name, bytes calldata data) external view returns (bytes memory);
}

interface IAddressResolver {
    function addr(bytes32 node, uint256 coinType) external view returns (bytes memory);
}

interface IVerifiableFactory {
    function verifyContract(address proxy) external view returns (address implementation);
}

contract EnsReadTest {
    uint256 private constant ETH_COIN_TYPE = 60;

    IUniversalResolverV2 public immutable universalResolver;
    IVerifiableFactory public immutable factory;
    address public immutable resolverImplementation;

    event RecordRead(
        bytes32 indexed node,
        address resolver,
        address record,
        uint256 findResolverGas,
        uint256 readRecordGas,
        uint256 verifyResolverGas
    );

    error NoResolver();
    error BadAddressRecord(bytes value);
    error ResolverNotGenuine(address resolver);

    constructor(IUniversalResolverV2 universalResolver_, IVerifiableFactory factory_, address resolverImplementation_) {
        universalResolver = universalResolver_;
        factory = factory_;
        resolverImplementation = resolverImplementation_;
    }

    function read(bytes calldata dnsName) external returns (address record) {
        uint256 start = gasleft();
        (address resolver, bytes32 node, uint256 offset) = universalResolver.findResolver(dnsName);
        if (resolver == address(0) || offset != 0) revert NoResolver();
        uint256 afterFind = gasleft();

        bytes memory value = abi.decode(
            IExtendedResolver(resolver).resolve(dnsName, abi.encodeCall(IAddressResolver.addr, (node, ETH_COIN_TYPE))),
            (bytes)
        );
        if (value.length != 20) revert BadAddressRecord(value);
        record = address(bytes20(value));
        uint256 afterRead = gasleft();

        if (factory.verifyContract(resolver) != resolverImplementation) revert ResolverNotGenuine(resolver);
        uint256 afterVerify = gasleft();

        emit RecordRead(node, resolver, record, start - afterFind, afterFind - afterRead, afterRead - afterVerify);
    }
}

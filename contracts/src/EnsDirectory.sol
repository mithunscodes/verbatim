// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IUniversalResolver {
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

contract EnsDirectory {
    uint256 private constant ETH_COIN_TYPE = 60;

    IUniversalResolver public immutable universalResolver;
    IVerifiableFactory public immutable verifiableFactory;
    address public immutable resolverImplementation;
    string[] public names;
    bytes[] private encodedNames;

    constructor(
        IUniversalResolver universalResolver_,
        IVerifiableFactory verifiableFactory_,
        address resolverImplementation_,
        string[] memory names_
    ) {
        universalResolver = universalResolver_;
        verifiableFactory = verifiableFactory_;
        resolverImplementation = resolverImplementation_;
        for (uint256 i = 0; i < names_.length; i++) {
            names.push(names_[i]);
            encodedNames.push(dnsEncode(names_[i]));
        }
    }

    function nameCount() external view returns (uint256) {
        return names.length;
    }

    function addressOf(string calldata name) external view returns (address) {
        return read(dnsEncode(name));
    }

    function isListed(address account) external view returns (bool) {
        if (account == address(0)) return false;
        for (uint256 i = 0; i < encodedNames.length; i++) {
            if (read(encodedNames[i]) == account) return true;
        }
        return false;
    }

    function listed() external view returns (address[] memory found) {
        address[] memory all = new address[](encodedNames.length);
        uint256 count = 0;
        for (uint256 i = 0; i < encodedNames.length; i++) {
            address account = read(encodedNames[i]);
            if (account != address(0)) all[count++] = account;
        }
        found = new address[](count);
        for (uint256 i = 0; i < count; i++) {
            found[i] = all[i];
        }
    }

    function read(bytes memory name) private view returns (address) {
        try universalResolver.findResolver(name) returns (address resolver, bytes32 node, uint256 offset) {
            if (resolver == address(0) || offset != 0 || !isGenuine(resolver)) return address(0);
            try IExtendedResolver(resolver).resolve(name, abi.encodeCall(IAddressResolver.addr, (node, ETH_COIN_TYPE))) returns (
                bytes memory result
            ) {
                bytes memory value = abi.decode(result, (bytes));
                return value.length == 20 ? address(bytes20(value)) : address(0);
            } catch {
                return address(0);
            }
        } catch {
            return address(0);
        }
    }

    function isGenuine(address resolver) private view returns (bool) {
        try verifiableFactory.verifyContract(resolver) returns (address implementation) {
            return implementation == resolverImplementation;
        } catch {
            return false;
        }
    }

    function dnsEncode(string memory name) private pure returns (bytes memory encoded) {
        bytes memory text = bytes(name);
        require(text.length > 0, "A name can't be empty");
        encoded = new bytes(text.length + 2);
        uint256 start = 0;
        for (uint256 i = 0; i <= text.length; i++) {
            if (i < text.length && text[i] != ".") continue;
            uint256 size = i - start;
            require(size > 0 && size < 64, "Each part of a name must be 1 to 63 characters");
            encoded[start] = bytes1(uint8(size));
            for (uint256 j = start; j < i; j++) {
                encoded[j + 1] = text[j];
            }
            start = i + 1;
        }
    }
}

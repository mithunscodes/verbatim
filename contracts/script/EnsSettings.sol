// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {EnsDirectory, IUniversalResolver, IVerifiableFactory} from "../src/EnsDirectory.sol";

library EnsSettings {
    address internal constant UNIVERSAL_RESOLVER = 0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe;
    address internal constant VERIFIABLE_FACTORY = 0xDa70306C98E97eCe36F997a21368e53298572991;
    address internal constant PERMISSIONED_RESOLVER_IMPL = 0x115eb53F0c60696633855F90b138178Fb40b2b2C;
    address internal constant USER_REGISTRY_IMPL = 0x9BD8a88719068D09ecee662f36C0E3856708366a;
    address internal constant ETH_REGISTRAR = 0xf633e7FC17e2bbE0D0965D18ec1821dcB754a3d3;
    address internal constant ETH_REGISTRY = 0xD4eBcbBdF463C9c45784603Db0dDD499BC44A8B4;
    address internal constant MOCK_USDC = 0x240b0316Df57887DBBE58b586508b19e633a14aa;

    string internal constant DIRECTORY_LABEL = "verbatim";

    function directoryName() internal pure returns (string memory) {
        return string.concat(DIRECTORY_LABEL, ".eth");
    }

    function trustedNames() internal pure returns (string[] memory names) {
        names = new string[](2);
        names[0] = string.concat("router.uniswap.", directoryName());
        names[1] = string.concat("prints.studio.", directoryName());
    }

    function deployDirectory() internal returns (EnsDirectory) {
        return new EnsDirectory(
            IUniversalResolver(UNIVERSAL_RESOLVER),
            IVerifiableFactory(VERIFIABLE_FACTORY),
            PERMISSIONED_RESOLVER_IMPL,
            trustedNames()
        );
    }
}

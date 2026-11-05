// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {PoolPriceSource} from "../src/PoolPriceSource.sol";

interface IUniswapV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
}

contract DeployPriceSource is Script {
    address constant BUILDER_KEY = 0xc0bF91f3BD0d479D5104d975B08885A73b032ce2;
    address constant FACTORY = 0x0227628f3F023bb0B980b67D528571c95c6DaC1c;
    address constant USDC = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238;
    address constant WETH = 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14;
    uint32 constant WINDOW = 2 hours;

    function run() external returns (PoolPriceSource source) {
        uint256 builderPrivateKey = vm.envUint("BUILDER_PRIVATE_KEY");
        require(vm.addr(builderPrivateKey) == BUILDER_KEY, "BUILDER_PRIVATE_KEY is not the Builder key");
        uint24[4] memory fees = [uint24(100), 500, 3000, 10000];
        address[] memory pools = new address[](fees.length);
        for (uint256 i = 0; i < fees.length; i++) {
            pools[i] = IUniswapV3Factory(FACTORY).getPool(USDC, WETH, fees[i]);
            require(pools[i] != address(0), "Pool not found");
            console.log("Pool:", pools[i]);
        }
        vm.startBroadcast(builderPrivateKey);
        source = new PoolPriceSource(USDC, WETH, pools, WINDOW);
        vm.stopBroadcast();
        console.log("Price source:", address(source));
        console.log("1 ETH in test USDC, 6 decimals:", source.valueOf(address(0), 1 ether));
    }
}

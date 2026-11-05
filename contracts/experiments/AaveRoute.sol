// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Like {
    function balanceOf(address owner) external view returns (uint256);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IAavePool {
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
}

interface IUniswapV3Pool {
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1);
}

interface IUniswapV2Pair {
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

contract AaveRoute {
    address private constant AAVE_POOL = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;
    address private constant A_ETH_USDT = 0x23878914EFE38d27C4D67Ab83ed1b93A74D4086a;
    address private constant USDT = 0xdAC17F958D2ee523a2206206994597C13D831ec7;
    address private constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address private constant UNISWAP_V3_WETH_USDT = 0x4e68Ccd3E89f51C3074ca5072bbAC773960dFa36;
    address private constant SUSHI_AAVE_WETH = 0xD75EA151a61d06868E31F8988D28DFE5E9df57B4;
    uint160 private constant MAX_SQRT_PRICE_MINUS_ONE = 1461446703485210103287273052203988822378723970341;

    event RouteDone(address indexed payer, uint256 usdtIn, uint256 wethOut, uint256 aaveOut);

    function swap(uint256 amount) external returns (uint256 aaveOut) {
        require(IERC20Like(A_ETH_USDT).transferFrom(msg.sender, address(this), amount), "aEthUSDT transfer failed");
        uint256 usdtIn = IAavePool(AAVE_POOL).withdraw(USDT, type(uint256).max, address(this));
        (int256 wethDelta,) = IUniswapV3Pool(UNISWAP_V3_WETH_USDT)
            .swap(SUSHI_AAVE_WETH, false, int256(usdtIn), MAX_SQRT_PRICE_MINUS_ONE, "");
        (uint112 reserveAave, uint112 reserveWeth,) = IUniswapV2Pair(SUSHI_AAVE_WETH).getReserves();
        uint256 wethIn = IERC20Like(WETH).balanceOf(SUSHI_AAVE_WETH) - reserveWeth;
        uint256 wethInWithFee = wethIn * 997;
        aaveOut = (wethInWithFee * reserveAave) / (uint256(reserveWeth) * 1000 + wethInWithFee);
        IUniswapV2Pair(SUSHI_AAVE_WETH).swap(aaveOut, 0, msg.sender, "");
        emit RouteDone(msg.sender, usdtIn, uint256(-wethDelta), aaveOut);
    }

    function uniswapV3SwapCallback(int256, int256 amount1Delta, bytes calldata) external {
        require(msg.sender == UNISWAP_V3_WETH_USDT, "Not the pool");
        (bool ok, bytes memory returned) = USDT.call(abi.encodeWithSelector(0xa9059cbb, msg.sender, uint256(amount1Delta)));
        require(ok && (returned.length == 0 || abi.decode(returned, (bool))), "USDT transfer failed");
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IReplayToken {
    function balanceOf(address owner) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IRoutePool {
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1);
}

interface IRoutePair {
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

contract ReplayRoute {
    address public immutable usdt;
    address public immutable weth;
    address public immutable pool;
    address public immutable pair;
    uint160 private constant MAX_SQRT_PRICE_MINUS_ONE = 1461446703485210103287273052203988822378723970341;

    event RouteDone(address indexed payer, uint256 usdtIn, uint256 wethOut, uint256 aaveOut);

    constructor(address usdt_, address weth_, address pool_, address pair_) {
        usdt = usdt_;
        weth = weth_;
        pool = pool_;
        pair = pair_;
    }

    function swap(uint256 amount) external returns (uint256 aaveOut) {
        require(IReplayToken(usdt).transferFrom(msg.sender, address(this), amount), "tUSDT transfer failed");
        (int256 wethDelta,) = IRoutePool(pool).swap(pair, false, int256(amount), MAX_SQRT_PRICE_MINUS_ONE, "");
        (uint112 reserveAave, uint112 reserveWeth,) = IRoutePair(pair).getReserves();
        uint256 wethIn = IReplayToken(weth).balanceOf(pair) - reserveWeth;
        uint256 wethInWithFee = wethIn * 997;
        aaveOut = (wethInWithFee * reserveAave) / (uint256(reserveWeth) * 1000 + wethInWithFee);
        IRoutePair(pair).swap(aaveOut, 0, msg.sender, "");
        emit RouteDone(msg.sender, amount, uint256(-wethDelta), aaveOut);
    }

    function uniswapV3SwapCallback(int256, int256 amount1Delta, bytes calldata) external {
        require(msg.sender == pool, "Not the pool");
        require(IReplayToken(usdt).transfer(msg.sender, uint256(amount1Delta)), "tUSDT transfer failed");
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReplayToken} from "./ReplayToken.sol";

interface IUniswapV3Factory {
    function createPool(address tokenA, address tokenB, uint24 fee) external returns (address pool);
}

interface IUniswapV3Pool {
    function initialize(uint160 sqrtPriceX96) external;
    function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool);
    function mint(address recipient, int24 tickLower, int24 tickUpper, uint128 amount, bytes calldata data)
        external
        returns (uint256 amount0, uint256 amount1);
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1);
}

interface IUniswapV2Factory {
    function createPair(address tokenA, address tokenB) external returns (address pair);
}

interface IUniswapV2Pair {
    function balanceOf(address owner) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function burn(address to) external returns (uint256 amount0, uint256 amount1);
    function mint(address to) external returns (uint256 liquidity);
    function sync() external;
}

contract ReplayPools {
    address public immutable owner;
    address public immutable v3Factory;
    address public immutable v2Factory;
    ReplayToken public usdt;
    ReplayToken public weth;
    ReplayToken public aave;
    address public pool;
    address public pair;
    uint160 public startPrice;
    uint256 public aaveReserve;
    uint256 public wethReserve;
    uint256 public amount;

    constructor(address owner_, address v3Factory_, address v2Factory_) {
        owner = owner_;
        v3Factory = v3Factory_;
        v2Factory = v2Factory_;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Only the owner");
        _;
    }

    function init(
        ReplayToken usdt_,
        ReplayToken weth_,
        ReplayToken aave_,
        uint24 fee,
        uint160 startPrice_,
        uint256 aaveReserve_,
        uint256 wethReserve_,
        uint256 amount_
    ) external onlyOwner {
        require(pool == address(0), "Already set up");
        require(address(aave_) < address(weth_) && address(weth_) < address(usdt_), "Token order must match mainnet");
        usdt = usdt_;
        weth = weth_;
        aave = aave_;
        startPrice = startPrice_;
        aaveReserve = aaveReserve_;
        wethReserve = wethReserve_;
        amount = amount_;
        pool = IUniswapV3Factory(v3Factory).createPool(address(weth_), address(usdt_), fee);
        IUniswapV3Pool(pool).initialize(startPrice_);
        pair = IUniswapV2Factory(v2Factory).createPair(address(aave_), address(weth_));
    }

    function addLiquidity(int24[] calldata lowers, int24[] calldata uppers, uint128[] calldata amounts) external onlyOwner {
        for (uint256 i = 0; i < lowers.length; i++) {
            IUniswapV3Pool(pool).mint(address(this), lowers[i], uppers[i], amounts[i], "");
        }
    }

    function reset(address[] calldata holders) external onlyOwner {
        (uint160 price,,,,,,) = IUniswapV3Pool(pool).slot0();
        if (price != startPrice) {
            IUniswapV3Pool(pool).swap(address(this), price > startPrice, int256(uint256(type(uint128).max)), startPrice, "");
        }
        (uint112 reserveAave, uint112 reserveWeth,) = IUniswapV2Pair(pair).getReserves();
        if (reserveAave != aaveReserve || reserveWeth != wethReserve) refillPair();
        for (uint256 i = 0; i < holders.length; i++) {
            fill(usdt, holders[i], amount);
        }
    }

    function isReset(address[] calldata holders) external view returns (bool) {
        (uint160 price,,,,,,) = IUniswapV3Pool(pool).slot0();
        (uint112 reserveAave, uint112 reserveWeth,) = IUniswapV2Pair(pair).getReserves();
        if (price != startPrice || reserveAave != aaveReserve || reserveWeth != wethReserve) return false;
        for (uint256 i = 0; i < holders.length; i++) {
            if (usdt.balanceOf(holders[i]) != amount) return false;
        }
        return true;
    }

    function uniswapV3MintCallback(uint256 owed0, uint256 owed1, bytes calldata) external {
        require(msg.sender == pool, "Not the pool");
        if (owed0 > 0) weth.mint(pool, owed0);
        if (owed1 > 0) usdt.mint(pool, owed1);
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        require(msg.sender == pool, "Not the pool");
        if (amount0Delta > 0) weth.mint(pool, uint256(amount0Delta));
        if (amount1Delta > 0) usdt.mint(pool, uint256(amount1Delta));
    }

    function refillPair() private {
        uint256 shares = IUniswapV2Pair(pair).balanceOf(address(this));
        if (shares > 0) {
            IUniswapV2Pair(pair).transfer(pair, shares);
            IUniswapV2Pair(pair).burn(address(this));
        }
        if (aave.balanceOf(pair) == 0) aave.mint(pair, 1);
        if (weth.balanceOf(pair) == 0) weth.mint(pair, 1);
        IUniswapV2Pair(pair).sync();
        fill(aave, pair, aaveReserve);
        fill(weth, pair, wethReserve);
        IUniswapV2Pair(pair).mint(address(this));
        (uint112 reserveAave, uint112 reserveWeth,) = IUniswapV2Pair(pair).getReserves();
        require(reserveAave == aaveReserve && reserveWeth == wethReserve, "The pair didn't go back exactly");
    }

    function fill(ReplayToken token, address holder, uint256 target) private {
        uint256 held = token.balanceOf(holder);
        if (held < target) token.mint(holder, target - held);
    }
}

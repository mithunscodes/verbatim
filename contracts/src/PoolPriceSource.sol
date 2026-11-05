// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPriceSource} from "./VerbatimVault.sol";

interface IUniswapV3Pool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);
}

contract PoolPriceSource is IPriceSource {
    uint256 constant MAX_TICK = 887272;

    address public immutable unit;
    address public immutable asset;
    uint32 public immutable window;
    bool public immutable unitIsToken0;
    address[] public pools;

    constructor(address unit_, address asset_, address[] memory pools_, uint32 window_) {
        require(pools_.length > 0, "No pools");
        require(window_ > 0, "No averaging window");
        bool first = IUniswapV3Pool(pools_[0]).token0() == unit_;
        (address token0, address token1) = first ? (unit_, asset_) : (asset_, unit_);
        for (uint256 i = 0; i < pools_.length; i++) {
            IUniswapV3Pool pool = IUniswapV3Pool(pools_[i]);
            require(pool.token0() == token0 && pool.token1() == token1, "Pool doesn't match");
        }
        unit = unit_;
        asset = asset_;
        window = window_;
        unitIsToken0 = first;
        pools = pools_;
    }

    function valueOf(address token, uint256 amount) external view returns (uint256) {
        if (token == unit) return amount;
        require(token == address(0) || token == asset, "No price for this token");
        int256 tick = medianTick();
        return unitIsToken0 ? scale(amount, -tick) : scale(amount, tick);
    }

    function medianTick() public view returns (int256) {
        int256[] memory ticks = new int256[](pools.length);
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = window;
        uint256 count = 0;
        for (uint256 i = 0; i < pools.length; i++) {
            try IUniswapV3Pool(pools[i]).observe(secondsAgos) returns (int56[] memory cumulatives, uint160[] memory) {
                ticks[count++] = averageTick(int256(cumulatives[1]) - int256(cumulatives[0]));
            } catch {}
        }
        require(count * 2 > pools.length, "Not enough price history");
        sort(ticks, count);
        if (count % 2 == 1) return ticks[count / 2];
        return (ticks[count / 2 - 1] + ticks[count / 2]) / 2;
    }

    function averageTick(int256 delta) private view returns (int256 tick) {
        int256 span = int256(uint256(window));
        tick = delta / span;
        if (delta < 0 && delta % span != 0) tick--;
    }

    function sort(int256[] memory values, uint256 count) private pure {
        for (uint256 i = 1; i < count; i++) {
            int256 value = values[i];
            uint256 j = i;
            while (j > 0 && values[j - 1] > value) {
                values[j] = values[j - 1];
                j--;
            }
            values[j] = value;
        }
    }

    function scale(uint256 amount, int256 exponent) private pure returns (uint256) {
        if (exponent <= 0) return (amount * shrinkX128(uint256(-exponent))) >> 128;
        return (amount * (1 << 128)) / shrinkX128(uint256(exponent));
    }

    function shrinkX128(uint256 n) private pure returns (uint256 r) {
        require(n <= MAX_TICK, "Price out of range");
        r = 1 << 128;
        if ((n & 0x1) != 0) r = (r * 0xfff97272373d413259a46990580e2139) >> 128;
        if ((n & 0x2) != 0) r = (r * 0xfff2e50f5f656932ef12357cf3c7fdcb) >> 128;
        if ((n & 0x4) != 0) r = (r * 0xffe5caca7e10e4e61c3624eaa0941ccf) >> 128;
        if ((n & 0x8) != 0) r = (r * 0xffcb9843d60f6159c9db58835c926643) >> 128;
        if ((n & 0x10) != 0) r = (r * 0xff973b41fa98c081472e6896dfb254bf) >> 128;
        if ((n & 0x20) != 0) r = (r * 0xff2ea16466c96a3843ec78b326b52860) >> 128;
        if ((n & 0x40) != 0) r = (r * 0xfe5dee046a99a2a811c461f1969c3052) >> 128;
        if ((n & 0x80) != 0) r = (r * 0xfcbe86c7900a88aedcffc83b479aa3a3) >> 128;
        if ((n & 0x100) != 0) r = (r * 0xf987a7253ac413176f2b074cf7815e53) >> 128;
        if ((n & 0x200) != 0) r = (r * 0xf3392b0822b70005940c7a398e4b70f2) >> 128;
        if ((n & 0x400) != 0) r = (r * 0xe7159475a2c29b7443b29c7fa6e889d8) >> 128;
        if ((n & 0x800) != 0) r = (r * 0xd097f3bdfd2022b8845ad8f792aa5825) >> 128;
        if ((n & 0x1000) != 0) r = (r * 0xa9f746462d870fdf8a65dc1f90e061e4) >> 128;
        if ((n & 0x2000) != 0) r = (r * 0x70d869a156d2a1b890bb3df62baf32f6) >> 128;
        if ((n & 0x4000) != 0) r = (r * 0x31be135f97d08fd981231505542fcfa5) >> 128;
        if ((n & 0x8000) != 0) r = (r * 0x9aa508b5b7a84e1c677de54f3e99bc8) >> 128;
        if ((n & 0x10000) != 0) r = (r * 0x5d6af8dedb81196699c329225ee604) >> 128;
        if ((n & 0x20000) != 0) r = (r * 0x2216e584f5fa1ea926041bedfe97) >> 128;
        if ((n & 0x40000) != 0) r = (r * 0x48a170391f7dc42444e8fa2) >> 128;
        if ((n & 0x80000) != 0) r = (r * 0x149b34ee7ac262) >> 128;
    }
}

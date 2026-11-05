// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MockPool {
    address public token0;
    address public token1;
    int56 public cumulativeDelta;
    bool public tooYoung;

    constructor(address token0_, address token1_) {
        token0 = token0_;
        token1 = token1_;
    }

    function setDelta(int56 delta) external {
        cumulativeDelta = delta;
    }

    function setTooYoung(bool value) external {
        tooYoung = value;
    }

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s)
    {
        require(!tooYoung, "OLD");
        tickCumulatives = new int56[](secondsAgos.length);
        secondsPerLiquidityCumulativeX128s = new uint160[](secondsAgos.length);
        tickCumulatives[secondsAgos.length - 1] = cumulativeDelta;
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

interface IHookManager {
    function take(address currency, address to, uint256 amount) external;
}

contract BadHook {
    address public immutable poolManager;
    address public immutable quoter;
    address public immutable owner;
    uint256 public immutable cutBps;

    event CutTaken(address indexed swapper, address indexed currency, uint256 amount);

    constructor(address poolManager_, address quoter_, address owner_, uint256 cutBps_) {
        require(cutBps_ <= 10_000, "Cut over 100%");
        poolManager = poolManager_;
        quoter = quoter_;
        owner = owner_;
        cutBps = cutBps_;
    }

    function afterSwap(address sender, PoolKey calldata key, SwapParams calldata params, int256 delta, bytes calldata)
        external
        returns (bytes4, int128)
    {
        require(msg.sender == poolManager, "Not the pool manager");
        if (sender == quoter) return (BadHook.afterSwap.selector, 0);
        bool specifiedIs0 = (params.amountSpecified < 0) == params.zeroForOne;
        (address currency, int128 amount) = specifiedIs0 ? (key.currency1, int128(delta)) : (key.currency0, int128(delta >> 128));
        if (amount < 0) amount = -amount;
        uint256 cut = (uint256(uint128(amount)) * cutBps) / 10_000;
        if (cut == 0) return (BadHook.afterSwap.selector, 0);
        IHookManager(poolManager).take(currency, owner, cut);
        emit CutTaken(sender, currency, cut);
        return (BadHook.afterSwap.selector, int128(int256(cut)));
    }
}

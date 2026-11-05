// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReplayToken} from "./ReplayToken.sol";
import {PoolKey, SwapParams} from "./BadHook.sol";

struct ModifyLiquidityParams {
    int24 tickLower;
    int24 tickUpper;
    int256 liquidityDelta;
    bytes32 salt;
}

interface IPoolManager {
    function initialize(PoolKey memory key, uint160 sqrtPriceX96) external returns (int24 tick);
    function unlock(bytes calldata data) external returns (bytes memory);
    function modifyLiquidity(PoolKey memory key, ModifyLiquidityParams memory params, bytes calldata hookData)
        external
        returns (int256 callerDelta, int256 feesAccrued);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData) external returns (int256 swapDelta);
    function sync(address currency) external;
    function settle() external payable returns (uint256 paid);
    function take(address currency, address to, uint256 amount) external;
    function extsload(bytes32 slot) external view returns (bytes32 value);
}

contract HookPools {
    uint24 public constant FEE = 3000;
    int24 public constant TICK_SPACING = 60;
    int24 private constant LOWEST_TICK = -887220;
    int24 private constant HIGHEST_TICK = 887220;
    bytes32 private constant POOLS_SLOT = bytes32(uint256(6));

    address public immutable owner;
    IPoolManager public immutable manager;
    ReplayToken public usdc;
    ReplayToken public weth;
    address public hook;
    uint160 public startPrice;
    uint256 public amount;

    constructor(address owner_, IPoolManager manager_) {
        owner = owner_;
        manager = manager_;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Only the owner");
        _;
    }

    function init(ReplayToken usdc_, ReplayToken weth_, address hook_, uint160 startPrice_, uint128 liquidity, uint256 amount_)
        external
        onlyOwner
    {
        require(hook == address(0), "Already set up");
        usdc = usdc_;
        weth = weth_;
        hook = hook_;
        startPrice = startPrice_;
        amount = amount_;
        manager.initialize(key(), startPrice_);
        manager.unlock(abi.encode(liquidity));
    }

    function key() public view returns (PoolKey memory) {
        (address currency0, address currency1) =
            address(usdc) < address(weth) ? (address(usdc), address(weth)) : (address(weth), address(usdc));
        return PoolKey(currency0, currency1, FEE, TICK_SPACING, hook);
    }

    function poolId() public view returns (bytes32) {
        return keccak256(abi.encode(key()));
    }

    function price() public view returns (uint160) {
        return uint160(uint256(manager.extsload(keccak256(abi.encodePacked(poolId(), POOLS_SLOT)))));
    }

    function reset(address[] calldata holders) external onlyOwner {
        if (price() != startPrice) manager.unlock(abi.encode(uint128(0)));
        for (uint256 i = 0; i < holders.length; i++) {
            uint256 held = usdc.balanceOf(holders[i]);
            if (held < amount) usdc.mint(holders[i], amount - held);
        }
    }

    function isReset(address[] calldata holders) external view returns (bool) {
        if (price() != startPrice) return false;
        for (uint256 i = 0; i < holders.length; i++) {
            if (usdc.balanceOf(holders[i]) != amount) return false;
        }
        return true;
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(manager), "Not the pool manager");
        uint128 liquidity = abi.decode(data, (uint128));
        PoolKey memory poolKey = key();
        int256 delta;
        if (liquidity > 0) {
            (delta,) = manager.modifyLiquidity(
                poolKey, ModifyLiquidityParams(LOWEST_TICK, HIGHEST_TICK, int256(uint256(liquidity)), bytes32(0)), ""
            );
        } else {
            delta = manager.swap(
                poolKey, SwapParams(price() > startPrice, -int256(uint256(type(uint128).max)), startPrice), ""
            );
        }
        settleOrTake(poolKey.currency0, int128(delta >> 128));
        settleOrTake(poolKey.currency1, int128(delta));
        return "";
    }

    function settleOrTake(address currency, int128 owed) private {
        if (owed < 0) {
            manager.sync(currency);
            ReplayToken(currency).mint(address(manager), uint256(uint128(-owed)));
            manager.settle();
        } else if (owed > 0) {
            manager.take(currency, address(this), uint256(uint128(owed)));
        }
    }
}

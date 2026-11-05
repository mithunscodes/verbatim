// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {VerbatimVault, IPermit2} from "../src/VerbatimVault.sol";
import {TestDirectory} from "./TestDirectory.sol";
import {PoolPriceSource} from "../src/PoolPriceSource.sol";
import {MockPool} from "./MockPool.sol";
import {TestToken} from "./TestToken.sol";
import {TestRouter} from "./TestRouter.sol";

interface IUniswapV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
}

interface IPoolSlot0 {
    function slot0()
        external
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool);
}

contract PoolPriceSourceTest is Test {
    uint32 constant WINDOW = 1800;
    address usdc = makeAddr("usdc");
    address weth = makeAddr("weth");

    function source(int256[] memory ticks, bool usdcFirst) internal returns (PoolPriceSource) {
        address[] memory pools = new address[](ticks.length);
        for (uint256 i = 0; i < ticks.length; i++) {
            MockPool pool = usdcFirst ? new MockPool(usdc, weth) : new MockPool(weth, usdc);
            pool.setDelta(int56(ticks[i] * int256(uint256(WINDOW))));
            pools[i] = address(pool);
        }
        return new PoolPriceSource(usdc, weth, pools, WINDOW);
    }

    function one(int256 tick) internal pure returns (int256[] memory ticks) {
        ticks = new int256[](1);
        ticks[0] = tick;
    }

    function test_OneEthAtSepoliasTick() public {
        assertApproxEqRel(source(one(168783), true).valueOf(address(0), 1 ether), 46_796_559_987, 1e9);
    }

    function test_PriceMathMatchesReferenceValues() public {
        int256[12] memory ticks =
            [int256(1), -1, 1000, -1000, 100000, -100000, 168783, 500000, -500000, 16400, -542736, -887272];
        uint256[12] memory expected = [
            uint256(999900009999000099),
            1000100000000000000,
            904841941932768878,
            1105165392603232697,
            45422633889328,
            22015456048552198645701,
            46796559987,
            0,
            5171760815372400971558161892130124037985,
            193995948246106827,
            371147496401242401156846636374824250592740,
            340256786836388094050805785052946541066751507546701582068
        ];
        for (uint256 i = 0; i < ticks.length; i++) {
            uint256 value = source(one(ticks[i]), true).valueOf(address(0), 1 ether);
            uint256 allowedError = ticks[i] == -887272 ? 1e14 : 1e9;
            if (expected[i] == 0) assertEq(value, 0);
            else assertApproxEqRel(value, expected[i], allowedError);
        }
    }

    function test_UnitIsWorthItsAmountAndEthEqualsWeth() public {
        PoolPriceSource prices = source(one(168783), true);
        assertEq(prices.valueOf(usdc, 123e6), 123e6);
        assertEq(prices.valueOf(weth, 1 ether), prices.valueOf(address(0), 1 ether));
    }

    function test_UnknownTokenRefused() public {
        PoolPriceSource prices = source(one(168783), true);
        address other = makeAddr("other");
        vm.expectRevert("No price for this token");
        prices.valueOf(other, 1);
    }

    function test_TokenOrderReversed() public {
        assertApproxEqRel(source(one(-168783), false).valueOf(address(0), 1 ether), 46_796_559_987, 1e9);
    }

    function test_MedianOfFourIsTheMiddlePair() public {
        int256[] memory ticks = new int256[](4);
        ticks[0] = 300;
        ticks[1] = 100000;
        ticks[2] = 100;
        ticks[3] = 200;
        assertEq(source(ticks, true).medianTick(), 250);
    }

    function test_MedianOfThree() public {
        int256[] memory ticks = new int256[](3);
        ticks[0] = 5;
        ticks[1] = -7;
        ticks[2] = 3;
        assertEq(source(ticks, true).medianTick(), 3);
    }

    function test_AveragesRoundDown() public {
        int56[4] memory deltas = [int56(-1), -1800, -1801, 1799];
        int256[4] memory expected = [int256(-1), -1, -2, 0];
        for (uint256 i = 0; i < deltas.length; i++) {
            MockPool pool = new MockPool(usdc, weth);
            pool.setDelta(deltas[i]);
            address[] memory pools = new address[](1);
            pools[0] = address(pool);
            assertEq(new PoolPriceSource(usdc, weth, pools, WINDOW).medianTick(), expected[i]);
        }
    }

    function test_SkipsAPoolWithoutEnoughHistoryButNeedsMostOfThem() public {
        MockPool[] memory mocks = new MockPool[](3);
        address[] memory pools = new address[](3);
        for (uint256 i = 0; i < 3; i++) {
            mocks[i] = new MockPool(usdc, weth);
            mocks[i].setDelta(int56(int256(100 * (i + 1)) * int256(uint256(WINDOW))));
            pools[i] = address(mocks[i]);
        }
        PoolPriceSource prices = new PoolPriceSource(usdc, weth, pools, WINDOW);
        assertEq(prices.medianTick(), 200);
        mocks[2].setTooYoung(true);
        assertEq(prices.medianTick(), 150);
        mocks[1].setTooYoung(true);
        vm.expectRevert("Not enough price history");
        prices.medianTick();
    }

    function test_PoolsMustMatch() public {
        address[] memory pools = new address[](2);
        pools[0] = address(new MockPool(usdc, weth));
        pools[1] = address(new MockPool(usdc, makeAddr("other")));
        vm.expectRevert("Pool doesn't match");
        new PoolPriceSource(usdc, weth, pools, WINDOW);
    }

    function test_TicksBeyondTheRangeAreRefused() public {
        PoolPriceSource prices = source(one(887273), true);
        vm.expectRevert("Price out of range");
        prices.valueOf(address(0), 1 ether);
    }

    function test_VaultUsesThePoolAverage() public {
        address permit2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
        vm.etch(permit2, vm.parseJsonBytes(vm.readFile("test/fixtures/permit2-sepolia.json"), ".code"));
        TestToken token = new TestToken();
        MockPool pool = new MockPool(address(token), weth);
        pool.setDelta(int56(168783 * int256(uint256(WINDOW))));
        address[] memory pools = new address[](1);
        pools[0] = address(pool);
        PoolPriceSource prices = new PoolPriceSource(address(token), weth, pools, WINDOW);
        TestRouter router = new TestRouter();
        vm.deal(address(router), 10 ether);
        address everydayKey = makeAddr("everydayKey");
        address rulesKey = makeAddr("rulesKey");
        address[] memory watched = new address[](1);
        watched[0] = address(token);
        address[] memory trusted = new address[](1);
        trusted[0] = address(router);
        VerbatimVault vault = new VerbatimVault(everydayKey, rulesKey, watched, address(new TestDirectory(trusted)));
        token.mint(address(vault), 1000e6);
        vm.startPrank(rulesKey);
        vault.setDailyLimit(address(token), 1000e6);
        vault.setPriceSource(address(prices));
        vault.finishSetup();
        vm.stopPrank();
        VerbatimVault.Check[] memory checks = new VerbatimVault.Check[](1);
        checks[0] = VerbatimVault.Check(VerbatimVault.CheckKind.AtMostLeaves, address(token), address(0), 46_796_560);
        vm.prank(everydayKey);
        vault.run(swapActions(token, router, 0.001 ether), checks, vm.getBlockTimestamp());
        assertEq(address(vault).balance, 0.001 ether);
        vm.prank(everydayKey);
        vm.expectRevert("Unfair trade");
        vault.run(swapActions(token, router, 0.0005 ether), checks, vm.getBlockTimestamp());
    }

    function swapActions(TestToken token, TestRouter router, uint256 ethOut)
        internal
        view
        returns (VerbatimVault.Action[] memory actions)
    {
        address permit2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
        actions = new VerbatimVault.Action[](3);
        actions[0] = VerbatimVault.Action(address(token), 0, abi.encodeCall(TestToken.approve, (permit2, 46_796_560)), 0);
        actions[1] = VerbatimVault.Action(
            permit2,
            0,
            abi.encodeCall(IPermit2.approve, (address(token), address(router), uint160(46_796_560), uint48(vm.getBlockTimestamp()))),
            0
        );
        actions[2] = VerbatimVault.Action(
            address(router), 0, abi.encodeCall(TestRouter.swap, (address(token), uint160(46_796_560), ethOut)), 0
        );
    }
}

contract PoolPriceSourceForkTest is Test {
    address constant FACTORY = 0x0227628f3F023bb0B980b67D528571c95c6DaC1c;
    address constant USDC = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238;
    address constant WETH = 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14;

    function test_SepoliaPoolsGiveASensibleEthPrice() public {
        string memory url = vm.envOr("SEPOLIA_RPC_URL", string(""));
        if (bytes(url).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(url);
        uint24[4] memory fees = [uint24(100), 500, 3000, 10000];
        address[] memory pools = new address[](4);
        for (uint256 i = 0; i < fees.length; i++) {
            pools[i] = IUniswapV3Factory(FACTORY).getPool(USDC, WETH, fees[i]);
            assertTrue(pools[i] != address(0));
        }
        PoolPriceSource prices = new PoolPriceSource(USDC, WETH, pools, 1800);
        uint256 gasBefore = gasleft();
        uint256 value = prices.valueOf(address(0), 1 ether);
        uint256 gasUsed = gasBefore - gasleft();
        (uint160 sqrtPrice,,,,,,) = IPoolSlot0(pools[1]).slot0();
        uint256 spot = (uint256(1e18) << 192) / (uint256(sqrtPrice) * sqrtPrice);
        emit log_named_uint("1 ETH in test USDC, 30-minute median of 4 pools (6 decimals)", value);
        emit log_named_uint("1 ETH in test USDC, spot price of the 0.05% pool (6 decimals)", spot);
        emit log_named_uint("Gas for one price read", gasUsed);
        emit log_named_int("Median tick", prices.medianTick());
        assertApproxEqRel(value, spot, 0.05e18);
    }
}

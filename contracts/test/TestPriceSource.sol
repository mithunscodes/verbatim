// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract TestPriceSource {
    struct Price {
        uint256 baseAmount;
        uint256 value;
    }

    mapping(address => Price) public prices;

    function setPrice(address token, uint256 baseAmount, uint256 value) external {
        prices[token] = Price(baseAmount, value);
    }

    function valueOf(address token, uint256 amount) external view returns (uint256) {
        Price memory price = prices[token];
        require(price.baseAmount > 0, "No price for this token");
        return amount * price.value / price.baseAmount;
    }
}

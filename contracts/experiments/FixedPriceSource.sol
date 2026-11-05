// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract FixedPriceSource {
    struct Price {
        uint256 answer;
        uint8 tokenDecimals;
    }

    mapping(address => Price) public prices;
    uint8 public immutable priceDecimals;

    constructor(address[] memory tokens, uint256[] memory answers, uint8[] memory tokenDecimals, uint8 priceDecimals_) {
        require(tokens.length == answers.length && tokens.length == tokenDecimals.length, "One price per token");
        for (uint256 i = 0; i < tokens.length; i++) {
            prices[tokens[i]] = Price(answers[i], tokenDecimals[i]);
        }
        priceDecimals = priceDecimals_;
    }

    function valueOf(address token, uint256 amount) external view returns (uint256) {
        Price memory price = prices[token];
        require(price.answer > 0, "No price for this token");
        return (amount * price.answer * 10 ** (18 - priceDecimals)) / 10 ** price.tokenDecimals;
    }
}

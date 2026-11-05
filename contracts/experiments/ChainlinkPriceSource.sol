// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAggregator {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
    function decimals() external view returns (uint8);
}

contract ChainlinkPriceSource {
    struct Feed {
        address feed;
        uint8 tokenDecimals;
    }

    mapping(address => Feed) public feeds;
    uint256 public immutable maxAge;

    constructor(address[] memory tokens, address[] memory feeds_, uint8[] memory tokenDecimals, uint256 maxAge_) {
        require(tokens.length == feeds_.length && tokens.length == tokenDecimals.length, "One feed per token");
        for (uint256 i = 0; i < tokens.length; i++) {
            feeds[tokens[i]] = Feed(feeds_[i], tokenDecimals[i]);
        }
        maxAge = maxAge_;
    }

    function valueOf(address token, uint256 amount) external view returns (uint256) {
        Feed memory feed = feeds[token];
        require(feed.feed != address(0), "No price for this token");
        (, int256 answer,, uint256 updatedAt,) = IAggregator(feed.feed).latestRoundData();
        require(answer > 0, "No price");
        require(block.timestamp - updatedAt <= maxAge, "Price too old");
        uint8 feedDecimals = IAggregator(feed.feed).decimals();
        return (amount * uint256(answer) * 10 ** (18 - feedDecimals)) / 10 ** feed.tokenDecimals;
    }
}

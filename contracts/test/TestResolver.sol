// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract TestResolver {
    bool public broken;
    uint256 public calls;
    address public lastCaller;

    function setBroken(bool broken_) external {
        broken = broken_;
    }

    function multicall(bytes[] calldata data) external returns (bytes[] memory results) {
        require(!broken, "Resolver broken");
        calls += data.length;
        lastCaller = msg.sender;
        results = new bytes[](data.length);
    }
}

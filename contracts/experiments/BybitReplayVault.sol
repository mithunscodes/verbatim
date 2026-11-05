// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract BybitReplayVault {
    address public immutable everydayKey;

    constructor(address everydayKey_) {
        everydayKey = everydayKey_;
    }

    receive() external payable {}

    function execute(address to, uint256 value, bytes calldata data, uint8 operation) external returns (bytes memory result) {
        require(msg.sender == everydayKey, "Only the everyday key");
        require(operation == 0, "Borrowed code would run in your account");
        bool ok;
        (ok, result) = to.call{value: value}(data);
        require(ok, "Call failed");
    }
}

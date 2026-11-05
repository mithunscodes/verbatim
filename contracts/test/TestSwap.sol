// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract TestSwap {
    receive() external payable {}

    function pay(uint256 ethOut) external {
        (bool ok,) = msg.sender.call{value: ethOut}("");
        require(ok, "Payment failed");
    }
}

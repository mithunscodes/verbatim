// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ITokenPull {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract TestSwap {
    receive() external payable {}

    function swap(address token, uint256 amountIn, uint256 ethOut) external {
        require(ITokenPull(token).transferFrom(msg.sender, address(this), amountIn), "Pull failed");
        (bool ok,) = msg.sender.call{value: ethOut}("");
        require(ok, "Payment failed");
    }
}

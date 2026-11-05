// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IPermit2Pull {
    function transferFrom(address from, address to, uint160 amount, address token) external;
}

interface ITokenTransfer {
    function transfer(address to, uint256 amount) external returns (bool);
}

contract TestRouter {
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    receive() external payable {}

    function swap(address token, uint160 amountIn, uint256 ethOut) external {
        swapTo(token, amountIn, ethOut, msg.sender);
    }

    function swapTo(address token, uint160 amountIn, uint256 ethOut, address recipient) public {
        IPermit2Pull(PERMIT2).transferFrom(msg.sender, address(this), amountIn, token);
        (bool ok,) = recipient.call{value: ethOut}("");
        require(ok, "Payment failed");
    }

    function sendTo(address token, uint160 amount, address recipient) external {
        IPermit2Pull(PERMIT2).transferFrom(msg.sender, recipient, amount, token);
    }

    function sell(address token, uint256 tokenOut) external payable {
        require(ITokenTransfer(token).transfer(msg.sender, tokenOut), "Payment failed");
    }
}

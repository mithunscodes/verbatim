// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract TestMultisig {
    address public immutable first;
    address public immutable second;
    mapping(bytes32 => uint256) public confirmations;

    constructor(address first_, address second_) {
        first = first_;
        second = second_;
    }

    function submit(address target, bytes calldata data) external {
        require(msg.sender == first || msg.sender == second, "Not an owner");
        bytes32 key = keccak256(abi.encode(target, data));
        confirmations[key] |= msg.sender == first ? 1 : 2;
        if (confirmations[key] != 3) return;
        delete confirmations[key];
        (bool ok,) = target.call(data);
        require(ok, "Call failed");
    }
}

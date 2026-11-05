// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract VerbatimVault {
    struct Action {
        address target;
        uint256 value;
        bytes data;
    }

    address public everydayKey;
    address public rulesKey;

    event Ran(bytes32 indexed actionsHash, uint256 actionCount, uint256 deadline);

    constructor(address everydayKey_, address rulesKey_) {
        require(everydayKey_ != address(0) && rulesKey_ != address(0), "Keys can't be empty");
        require(everydayKey_ != rulesKey_, "The two keys must be different");
        everydayKey = everydayKey_;
        rulesKey = rulesKey_;
    }

    receive() external payable {}

    function run(Action[] calldata actions, uint256 deadline) external {
        require(msg.sender == everydayKey, "Only the everyday key can run");
        require(block.timestamp <= deadline, "Deadline passed");
        for (uint256 i = 0; i < actions.length; i++) {
            (bool ok,) = actions[i].target.call{value: actions[i].value}(actions[i].data);
            require(ok, "An action failed");
        }
        emit Ran(keccak256(abi.encode(actions)), actions.length, deadline);
    }
}

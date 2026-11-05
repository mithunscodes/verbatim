// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
}

contract VerbatimVault {
    enum CheckKind {
        AtMostLeaves,
        AtLeastArrives,
        ExactlyTo
    }

    struct Action {
        address target;
        uint256 value;
        bytes data;
    }

    struct Check {
        CheckKind kind;
        address token;
        address to;
        uint256 amount;
    }

    address public everydayKey;
    address public rulesKey;
    bool transient running;

    event Ran(bytes32 indexed actionsHash, bytes32 indexed checksHash, uint256 actionCount, uint256 deadline);

    error CheckFailed(uint256 checkNumber, string check, uint256 expected, uint256 actual);

    constructor(address everydayKey_, address rulesKey_) {
        require(everydayKey_ != address(0) && rulesKey_ != address(0), "Keys can't be empty");
        require(everydayKey_ != rulesKey_, "The two keys must be different");
        everydayKey = everydayKey_;
        rulesKey = rulesKey_;
    }

    receive() external payable {}

    function run(Action[] calldata actions, Check[] calldata checks, uint256 deadline) external {
        require(msg.sender == everydayKey, "Only the everyday key can run");
        require(block.timestamp <= deadline, "Deadline passed");
        require(!running, "Already running");
        running = true;
        uint256[] memory balancesBefore = measure(checks);
        for (uint256 i = 0; i < actions.length; i++) {
            (bool ok,) = actions[i].target.call{value: actions[i].value}(actions[i].data);
            require(ok, "An action failed");
        }
        verify(checks, balancesBefore);
        running = false;
        emit Ran(keccak256(abi.encode(actions)), keccak256(abi.encode(checks)), actions.length, deadline);
    }

    function measure(Check[] calldata checks) private view returns (uint256[] memory balances) {
        balances = new uint256[](checks.length);
        for (uint256 i = 0; i < checks.length; i++) {
            balances[i] = balanceFor(checks[i]);
        }
    }

    function verify(Check[] calldata checks, uint256[] memory balancesBefore) private view {
        for (uint256 i = 0; i < checks.length; i++) {
            Check calldata check = checks[i];
            uint256 balanceBefore = balancesBefore[i];
            uint256 balanceAfter = balanceFor(check);
            uint256 left = balanceBefore > balanceAfter ? balanceBefore - balanceAfter : 0;
            uint256 arrived = balanceAfter > balanceBefore ? balanceAfter - balanceBefore : 0;
            if (check.kind == CheckKind.AtMostLeaves) {
                if (left > check.amount) revert CheckFailed(i + 1, "At most X leaves", check.amount, left);
            } else if (check.kind == CheckKind.AtLeastArrives) {
                if (arrived < check.amount) revert CheckFailed(i + 1, "At least Y arrives", check.amount, arrived);
            } else {
                if (arrived != check.amount) revert CheckFailed(i + 1, "Exactly X to this address", check.amount, arrived);
            }
        }
    }

    function balanceFor(Check calldata check) private view returns (uint256) {
        address account = check.kind == CheckKind.ExactlyTo ? check.to : address(this);
        return check.token == address(0) ? account.balance : IERC20(check.token).balanceOf(account);
    }
}

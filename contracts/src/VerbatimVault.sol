// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
    function allowance(address user, address token, address spender) external view returns (uint160 amount, uint48 expiration, uint48 nonce);
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
        uint8 operation;
    }

    struct Check {
        CheckKind kind;
        address token;
        address to;
        uint256 amount;
    }

    struct Permission {
        address token;
        address spender;
        bool viaPermit2;
    }

    address public constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    address public everydayKey;
    address public rulesKey;
    address[] public watchedTokens;
    address[] public trustedContracts;
    address[] public contacts;
    bool transient running;

    event Ran(bytes32 indexed actionsHash, bytes32 indexed checksHash, uint256 actionCount, uint256 deadline);
    event ContactSaved(address indexed contact);

    error CheckFailed(uint256 checkNumber, string check, uint256 expected, uint256 actual);

    constructor(address everydayKey_, address rulesKey_, address[] memory watchedTokens_, address[] memory trustedContracts_) {
        require(everydayKey_ != address(0) && rulesKey_ != address(0), "Keys can't be empty");
        require(everydayKey_ != rulesKey_, "The two keys must be different");
        everydayKey = everydayKey_;
        rulesKey = rulesKey_;
        watchedTokens = watchedTokens_;
        trustedContracts = trustedContracts_;
    }

    receive() external payable {}

    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) {
        return 0xffffffff;
    }

    function saveContact(address contact) external {
        require(msg.sender == rulesKey, "Only the rules key can save contacts");
        require(contact != address(0), "A contact can't be empty");
        require(!contains(contacts, contact), "Already a saved contact");
        contacts.push(contact);
        emit ContactSaved(contact);
    }

    function run(Action[] calldata actions, Check[] calldata checks, uint256 deadline) external {
        require(msg.sender == everydayKey, "Only the everyday key can run");
        require(block.timestamp <= deadline, "Deadline passed");
        require(!running, "Already running");
        running = true;
        bytes32 accountBefore = fingerprint();
        Permission[] memory permissions = inspect(actions);
        uint256[] memory balancesBefore = measure(checks);
        uint256[] memory holdingsBefore = holdings();
        execute(actions);
        verify(checks, balancesBefore);
        requireNoPermissionLeft(permissions);
        requireNothingElseLeft(checks, holdingsBefore);
        require(fingerprint() == accountBefore, "Your account would change");
        running = false;
        emit Ran(keccak256(abi.encode(actions)), keccak256(abi.encode(checks)), actions.length, deadline);
    }

    function inspect(Action[] calldata actions) private view returns (Permission[] memory permissions) {
        permissions = new Permission[](actions.length);
        for (uint256 i = 0; i < actions.length; i++) {
            permissions[i] = inspectOne(actions[i]);
        }
    }

    function inspectOne(Action calldata action) private view returns (Permission memory none) {
        require(action.operation == 0, "Borrowed code would run in your account");
        if (action.data.length == 0) {
            require(contains(contacts, action.target), "Not a saved contact");
            return none;
        }
        if (contains(watchedTokens, action.target)) {
            require(action.data.length >= 4, "This kind of action isn't allowed");
            bytes4 selector = bytes4(action.data[:4]);
            if (selector == IERC20.transfer.selector) {
                (address to,) = abi.decode(action.data[4:], (address, uint256));
                require(contains(contacts, to), "Not a saved contact");
                return none;
            }
            require(selector == IERC20.approve.selector, "This kind of action isn't allowed");
            (address spender,) = abi.decode(action.data[4:], (address, uint256));
            require(spender == PERMIT2 || contains(trustedContracts, spender), "Permission for an untrusted contract");
            return Permission(action.target, spender, false);
        }
        if (action.target == PERMIT2) {
            require(action.data.length >= 4 && bytes4(action.data[:4]) == IPermit2.approve.selector, "This kind of action isn't allowed");
            (address token, address spender,,) = abi.decode(action.data[4:], (address, address, uint160, uint48));
            require(contains(trustedContracts, spender), "Permission for an untrusted contract");
            return Permission(token, spender, true);
        }
        require(contains(trustedContracts, action.target), "Not a trusted contract");
    }

    function execute(Action[] calldata actions) private {
        for (uint256 i = 0; i < actions.length; i++) {
            (bool ok,) = actions[i].target.call{value: actions[i].value}(actions[i].data);
            require(ok, "An action failed");
        }
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

    function requireNoPermissionLeft(Permission[] memory permissions) private view {
        for (uint256 i = 0; i < permissions.length; i++) {
            Permission memory permission = permissions[i];
            if (permission.token == address(0)) continue;
            uint256 left;
            if (permission.viaPermit2) {
                (left,,) = IPermit2(PERMIT2).allowance(address(this), permission.token, permission.spender);
            } else {
                left = IERC20(permission.token).allowance(address(this), permission.spender);
            }
            require(left == 0, "Permission left behind");
        }
    }

    function holdings() private view returns (uint256[] memory amounts) {
        amounts = new uint256[](watchedTokens.length + 1);
        amounts[0] = address(this).balance;
        for (uint256 i = 0; i < watchedTokens.length; i++) {
            amounts[i + 1] = IERC20(watchedTokens[i]).balanceOf(address(this));
        }
    }

    function requireNothingElseLeft(Check[] calldata checks, uint256[] memory holdingsBefore) private view {
        uint256[] memory holdingsAfter = holdings();
        for (uint256 i = 0; i < holdingsAfter.length; i++) {
            if (holdingsAfter[i] >= holdingsBefore[i]) continue;
            address token = i == 0 ? address(0) : watchedTokens[i - 1];
            require(hasLimit(checks, token), "Something else would leave your account");
        }
    }

    function hasLimit(Check[] calldata checks, address token) private pure returns (bool) {
        for (uint256 i = 0; i < checks.length; i++) {
            if (checks[i].kind == CheckKind.AtMostLeaves && checks[i].token == token) return true;
        }
        return false;
    }

    function fingerprint() private view returns (bytes32) {
        address[] memory watched = watchedTokens;
        address[] memory trusted = trustedContracts;
        address[] memory saved = contacts;
        return keccak256(abi.encode(everydayKey, rulesKey, watched, trusted, saved, address(this).codehash));
    }

    function contains(address[] storage list, address item) private view returns (bool) {
        for (uint256 i = 0; i < list.length; i++) {
            if (list[i] == item) return true;
        }
        return false;
    }
}

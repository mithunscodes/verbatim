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

    struct Allowance {
        address token;
        uint256 amount;
        uint256 activeFrom;
        uint256 expiresAt;
        bool used;
    }

    address public constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    address public everydayKey;
    address public rulesKey;
    address[] public watchedTokens;
    address[] public trustedContracts;
    address[] public contacts;
    uint256[] dailyLimits;
    uint256[] spentToday;
    uint256[] dayStarted;
    uint256[] newContactLimits;
    uint256 public allowanceValidity = 48 hours;
    uint256 public newContactPeriod = 24 hours;
    uint256 public allowanceMinAge = 7 days;
    mapping(address => Allowance) public allowances;
    mapping(address => uint256) public savedAt;
    mapping(address => mapping(uint256 => uint256)) receivedWhileNew;
    bool transient running;

    event Ran(bytes32 indexed actionsHash, bytes32 indexed checksHash, uint256 actionCount, uint256 deadline);
    event ContactSaved(address indexed contact);
    event DailyLimitSet(address indexed token, uint256 amount);
    event AllowanceValiditySet(uint256 duration);
    event AllowanceCreated(address indexed contact, address indexed token, uint256 amount, uint256 activeFrom, uint256 expiresAt);
    event AllowanceUsed(address indexed contact, address indexed token, uint256 amount);
    event NewContactLimitSet(address indexed token, uint256 amount);
    event NewContactPeriodSet(uint256 duration);
    event AllowanceMinAgeSet(uint256 duration);

    error CheckFailed(uint256 checkNumber, string check, uint256 expected, uint256 actual);

    constructor(address everydayKey_, address rulesKey_, address[] memory watchedTokens_, address[] memory trustedContracts_) {
        require(everydayKey_ != address(0) && rulesKey_ != address(0), "Keys can't be empty");
        require(everydayKey_ != rulesKey_, "The two keys must be different");
        everydayKey = everydayKey_;
        rulesKey = rulesKey_;
        watchedTokens = watchedTokens_;
        trustedContracts = trustedContracts_;
        dailyLimits = new uint256[](watchedTokens_.length + 1);
        spentToday = new uint256[](watchedTokens_.length + 1);
        dayStarted = new uint256[](watchedTokens_.length + 1);
        newContactLimits = new uint256[](watchedTokens_.length + 1);
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
        savedAt[contact] = block.timestamp;
        emit ContactSaved(contact);
    }

    function setDailyLimit(address token, uint256 amount) external {
        require(msg.sender == rulesKey, "Only the rules key can set limits");
        dailyLimits[indexOf(token)] = amount;
        emit DailyLimitSet(token, amount);
    }

    function setAllowanceValidity(uint256 duration) external {
        require(msg.sender == rulesKey, "Only the rules key can change settings");
        allowanceValidity = duration;
        emit AllowanceValiditySet(duration);
    }

    function setNewContactLimit(address token, uint256 amount) external {
        require(msg.sender == rulesKey, "Only the rules key can set limits");
        newContactLimits[indexOf(token)] = amount;
        emit NewContactLimitSet(token, amount);
    }

    function setNewContactPeriod(uint256 duration) external {
        require(msg.sender == rulesKey, "Only the rules key can change settings");
        newContactPeriod = duration;
        emit NewContactPeriodSet(duration);
    }

    function setAllowanceMinAge(uint256 duration) external {
        require(msg.sender == rulesKey, "Only the rules key can change settings");
        allowanceMinAge = duration;
        emit AllowanceMinAgeSet(duration);
    }

    function createAllowance(address contact, address token, uint256 amount) external {
        require(msg.sender == rulesKey, "Only the rules key can create allowances");
        require(contains(contacts, contact), "Not a saved contact");
        require(oldEnough(contact), "Contact too new for big payments");
        require(token == address(0) || contains(watchedTokens, token), "Not a watched token");
        require(amount > 0, "An allowance can't be empty");
        uint256 expiresAt = block.timestamp + allowanceValidity;
        allowances[contact] = Allowance(token, amount, block.timestamp, expiresAt, false);
        emit AllowanceCreated(contact, token, amount, block.timestamp, expiresAt);
    }

    function payWithAllowance(address contact, uint256 amount) external {
        require(msg.sender == everydayKey, "Only the everyday key can pay");
        Allowance storage allowance = allowances[contact];
        require(allowance.amount > 0, "No allowance for this contact");
        require(!allowance.used, "Allowance already used");
        require(block.timestamp >= allowance.activeFrom, "Allowance not active yet");
        require(block.timestamp <= allowance.expiresAt, "Allowance expired");
        require(amount <= allowance.amount, "More than the allowance");
        require(oldEnough(contact), "Contact too new for big payments");
        allowance.used = true;
        emit AllowanceUsed(contact, allowance.token, amount);
        if (allowance.token == address(0)) {
            (bool ok,) = contact.call{value: amount}("");
            require(ok, "Payment failed");
        } else {
            require(IERC20(allowance.token).transfer(contact, amount), "Payment failed");
        }
    }

    function dailyLimit(address token) external view returns (uint256) {
        return dailyLimits[indexOf(token)];
    }

    function leftToday(address token) external view returns (uint256) {
        uint256 i = indexOf(token);
        uint256 spent = dayOver(i) ? 0 : spentToday[i];
        return spent >= dailyLimits[i] ? 0 : dailyLimits[i] - spent;
    }

    function newContactLimit(address token) external view returns (uint256) {
        return newContactLimits[indexOf(token)];
    }

    function run(Action[] calldata actions, Check[] calldata checks, uint256 deadline) external {
        require(msg.sender == everydayKey, "Only the everyday key can run");
        require(block.timestamp <= deadline, "Deadline passed");
        require(!running, "Already running");
        running = true;
        bytes32 accountBefore = fingerprint();
        Permission[] memory permissions = inspect(actions);
        uint256[] memory balancesBefore = measure(checks);
        uint256[] memory holdingsBefore = holdingsOf(address(this));
        address[] memory fresh = newContacts();
        uint256[][] memory freshBefore = measureAccounts(fresh);
        execute(actions);
        verify(checks, balancesBefore);
        requireNoPermissionLeft(permissions);
        uint256[] memory holdingsAfter = holdingsOf(address(this));
        requireNothingElseLeft(checks, holdingsBefore, holdingsAfter);
        countTowardDailyLimits(holdingsBefore, holdingsAfter);
        countTowardNewContactLimits(fresh, freshBefore);
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

    function holdingsOf(address account) private view returns (uint256[] memory amounts) {
        amounts = new uint256[](watchedTokens.length + 1);
        amounts[0] = account.balance;
        for (uint256 i = 0; i < watchedTokens.length; i++) {
            amounts[i + 1] = IERC20(watchedTokens[i]).balanceOf(account);
        }
    }

    function newContacts() private view returns (address[] memory fresh) {
        uint256 count = 0;
        for (uint256 i = 0; i < contacts.length; i++) {
            if (isNew(contacts[i])) count++;
        }
        fresh = new address[](count);
        uint256 next = 0;
        for (uint256 i = 0; i < contacts.length; i++) {
            if (isNew(contacts[i])) fresh[next++] = contacts[i];
        }
    }

    function measureAccounts(address[] memory accounts) private view returns (uint256[][] memory amounts) {
        amounts = new uint256[][](accounts.length);
        for (uint256 i = 0; i < accounts.length; i++) {
            amounts[i] = holdingsOf(accounts[i]);
        }
    }

    function countTowardNewContactLimits(address[] memory fresh, uint256[][] memory before) private {
        for (uint256 i = 0; i < fresh.length; i++) {
            uint256[] memory afterwards = holdingsOf(fresh[i]);
            for (uint256 j = 0; j < afterwards.length; j++) {
                if (afterwards[j] <= before[i][j]) continue;
                receivedWhileNew[fresh[i]][j] += afterwards[j] - before[i][j];
                require(receivedWhileNew[fresh[i]][j] <= newContactLimits[j], "Over the new-contact limit");
            }
        }
    }

    function isNew(address contact) private view returns (bool) {
        return block.timestamp < savedAt[contact] + newContactPeriod;
    }

    function oldEnough(address contact) private view returns (bool) {
        return block.timestamp >= savedAt[contact] + allowanceMinAge;
    }

    function requireNothingElseLeft(Check[] calldata checks, uint256[] memory holdingsBefore, uint256[] memory holdingsAfter)
        private
        view
    {
        for (uint256 i = 0; i < holdingsAfter.length; i++) {
            if (holdingsAfter[i] >= holdingsBefore[i]) continue;
            address token = i == 0 ? address(0) : watchedTokens[i - 1];
            require(hasLimit(checks, token), "Something else would leave your account");
        }
    }

    function countTowardDailyLimits(uint256[] memory holdingsBefore, uint256[] memory holdingsAfter) private {
        for (uint256 i = 0; i < holdingsAfter.length; i++) {
            if (holdingsAfter[i] >= holdingsBefore[i]) continue;
            if (dayOver(i)) {
                dayStarted[i] = block.timestamp;
                spentToday[i] = 0;
            }
            spentToday[i] += holdingsBefore[i] - holdingsAfter[i];
            require(spentToday[i] <= dailyLimits[i], "Over the daily limit");
        }
    }

    function dayOver(uint256 i) private view returns (bool) {
        return dayStarted[i] == 0 || block.timestamp >= dayStarted[i] + 1 days;
    }

    function indexOf(address token) private view returns (uint256) {
        if (token == address(0)) return 0;
        for (uint256 i = 0; i < watchedTokens.length; i++) {
            if (watchedTokens[i] == token) return i + 1;
        }
        revert("Not a watched token");
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
        uint256[] memory limits = dailyLimits;
        uint256[] memory newLimits = newContactLimits;
        Allowance[] memory given = new Allowance[](saved.length);
        uint256[] memory ages = new uint256[](saved.length);
        for (uint256 i = 0; i < saved.length; i++) {
            given[i] = allowances[saved[i]];
            ages[i] = savedAt[saved[i]];
        }
        bytes32 settings = keccak256(abi.encode(limits, newLimits, allowanceValidity, newContactPeriod, allowanceMinAge));
        return keccak256(abi.encode(everydayKey, rulesKey, watched, trusted, saved, given, ages, settings, address(this).codehash));
    }

    function contains(address[] storage list, address item) private view returns (bool) {
        for (uint256 i = 0; i < list.length; i++) {
            if (list[i] == item) return true;
        }
        return false;
    }
}

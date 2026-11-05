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

interface IPriceSource {
    function valueOf(address token, uint256 amount) external view returns (uint256);
}

interface IEnsDirectory {
    function listed() external view returns (address[] memory);
    function isListed(address account) external view returns (bool);
    function addressOf(string calldata name) external view returns (address);
    function resolverOf(string calldata name) external view returns (address);
    function records(address vault, uint256 kind, uint256 detail) external view returns (bytes[] memory);
}

interface IMulticallResolver {
    function multicall(bytes[] calldata calls) external returns (bytes[] memory);
}

contract VerbatimVault {
    enum CheckKind {
        AtMostLeaves,
        AtLeastArrives,
        ExactlyTo
    }

    enum ChangeKind {
        DailyLimit,
        NewContactLimit,
        Allowance,
        AllowanceValidity,
        NewContactPeriod,
        AllowanceMinAge,
        LooseningWait,
        TradeTolerance,
        PriceSource,
        ContactAddress
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

    struct KnownContracts {
        bool read;
        address[] list;
    }

    struct Change {
        ChangeKind kind;
        address contact;
        address token;
        uint256 value;
        uint256 valueBefore;
        uint256 readyAt;
        uint256 expiresAt;
        bool cancelled;
        bool done;
    }

    address public constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    uint256 private constant ENS_GAS = 3_000_000;
    uint256 private constant MAX_WAITING = 5;

    address public everydayKey;
    address public rulesKey;
    address[] public watchedTokens;
    address public directory;
    address[] public contacts;
    uint256[] dailyLimits;
    uint256[] spentToday;
    uint256[] dayStarted;
    uint256[] newContactLimits;
    uint256 public allowanceValidity = 48 hours;
    uint256 public newContactPeriod = 24 hours;
    uint256 public allowanceMinAge = 7 days;
    uint256 public looseningWait = 24 hours;
    uint256 public tradeTolerance = 300;
    address public priceSource;
    string public ensName;
    address public ensResolver;
    bool public setupFinished;
    mapping(address => Allowance) public allowances;
    mapping(address => uint256) public savedAt;
    mapping(address => string) public nameOf;
    mapping(bytes32 => address) public pinnedAddress;
    mapping(address => mapping(uint256 => uint256)) receivedWhileNew;
    Change[] public changes;
    uint256 waitingChanges;
    bool transient running;

    event Ran(bytes32 indexed actionsHash, bytes32 indexed checksHash, uint256 actionCount, uint256 deadline);
    event ContactSaved(address indexed contact);
    event ContactNamed(address indexed contact, string name);
    event DailyLimitSet(address indexed token, uint256 amount);
    event AllowanceValiditySet(uint256 duration);
    event AllowanceCreated(address indexed contact, address indexed token, uint256 amount, uint256 activeFrom, uint256 expiresAt);
    event AllowanceUsed(address indexed contact, address indexed token, uint256 amount);
    event NewContactLimitSet(address indexed token, uint256 amount);
    event NewContactPeriodSet(uint256 duration);
    event AllowanceMinAgeSet(uint256 duration);
    event LooseningWaitSet(uint256 duration);
    event TradeToleranceSet(uint256 basisPoints);
    event PriceSourceSet(address source);
    event SetupFinished();
    event ChangeProposed(uint256 indexed id, ChangeKind kind, address contact, address token, uint256 value);
    event ChangeApproved(uint256 indexed id, uint256 readyAt, uint256 expiresAt);
    event ChangeCancelled(uint256 indexed id);
    event ChangeSwitchedOn(uint256 indexed id);

    error CheckFailed(uint256 checkNumber, string check, uint256 expected, uint256 actual);

    constructor(address everydayKey_, address rulesKey_, address[] memory watchedTokens_, address directory_) {
        require(everydayKey_ != address(0) && rulesKey_ != address(0), "Keys can't be empty");
        require(everydayKey_ != rulesKey_, "The two keys must be different");
        require(directory_ != address(0), "The directory can't be empty");
        everydayKey = everydayKey_;
        rulesKey = rulesKey_;
        watchedTokens = watchedTokens_;
        directory = directory_;
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
        recordContact(contact);
    }

    function saveContactName(string calldata name) external {
        require(msg.sender == rulesKey, "Only the rules key can save contacts");
        require(pinnedAddress[keccak256(bytes(name))] == address(0), "This name is already saved");
        address contact = IEnsDirectory(directory).addressOf(name);
        require(contact != address(0), "This name has no address");
        recordContact(contact);
        pin(name, contact);
    }

    function recordContact(address contact) private {
        require(contact != address(0), "A contact can't be empty");
        require(contact != address(this), "Your account can't be its own contact");
        require(!contains(contacts, contact), "Already a saved contact");
        require(
            contact != PERMIT2 && !IEnsDirectory(directory).isListed(contact) && !contains(watchedTokens, contact),
            "A token or trusted contract can't be a contact"
        );
        contacts.push(contact);
        savedAt[contact] = block.timestamp;
        emit ContactSaved(contact);
    }

    function pin(string memory name, address contact) private {
        nameOf[contact] = name;
        pinnedAddress[keccak256(bytes(name))] = contact;
        emit ContactNamed(contact, name);
        publish(2, uint256(uint160(contact)));
    }

    function publish(uint256 kind, uint256 detail) private {
        if (ensResolver == address(0)) return;
        require(gasleft() > ENS_GAS, "Not enough gas to update ENS");
        try IEnsDirectory(directory).records(address(this), kind, detail) returns (bytes[] memory calls) {
            try IMulticallResolver(ensResolver).multicall(calls) {} catch {}
        } catch {}
    }

    function requireSameAddress(address contact) private view {
        string storage name = nameOf[contact];
        if (bytes(name).length == 0) return;
        require(IEnsDirectory(directory).addressOf(name) == contact, "This contact's address changed");
    }

    function setDailyLimit(address token, uint256 amount) external {
        require(msg.sender == rulesKey, "Only the rules key can set limits");
        changeRule(ChangeKind.DailyLimit, token, amount);
    }

    function setAllowanceValidity(uint256 duration) external {
        require(msg.sender == rulesKey, "Only the rules key can change settings");
        changeRule(ChangeKind.AllowanceValidity, address(0), duration);
    }

    function setNewContactLimit(address token, uint256 amount) external {
        require(msg.sender == rulesKey, "Only the rules key can set limits");
        changeRule(ChangeKind.NewContactLimit, token, amount);
    }

    function setNewContactPeriod(uint256 duration) external {
        require(msg.sender == rulesKey, "Only the rules key can change settings");
        changeRule(ChangeKind.NewContactPeriod, address(0), duration);
    }

    function setAllowanceMinAge(uint256 duration) external {
        require(msg.sender == rulesKey, "Only the rules key can change settings");
        changeRule(ChangeKind.AllowanceMinAge, address(0), duration);
    }

    function setLooseningWait(uint256 duration) external {
        require(msg.sender == rulesKey, "Only the rules key can change settings");
        changeRule(ChangeKind.LooseningWait, address(0), duration);
    }

    function setTradeTolerance(uint256 basisPoints) external {
        require(msg.sender == rulesKey, "Only the rules key can change settings");
        changeRule(ChangeKind.TradeTolerance, address(0), basisPoints);
    }

    function setPriceSource(address source) external {
        require(msg.sender == rulesKey, "Only the rules key can change settings");
        changeRule(ChangeKind.PriceSource, address(0), uint256(uint160(source)));
    }

    function setEnsName(string calldata name) external {
        require(msg.sender == rulesKey, "Only the rules key can change settings");
        require(!setupFinished, "Setup already finished");
        address resolver = IEnsDirectory(directory).resolverOf(name);
        require(resolver != address(0), "This name has no genuine ENS resolver");
        ensName = name;
        ensResolver = resolver;
        publish(0, 0);
    }

    function finishSetup() external {
        require(msg.sender == rulesKey, "Only the rules key can finish setup");
        require(!setupFinished, "Setup already finished");
        setupFinished = true;
        emit SetupFinished();
    }

    function propose(ChangeKind kind, address contact, address token, uint256 value) external returns (uint256 id) {
        require(msg.sender == everydayKey, "Only the everyday key can propose");
        if (kind == ChangeKind.Allowance || kind == ChangeKind.DailyLimit || kind == ChangeKind.NewContactLimit) {
            require(token == address(0) || contains(watchedTokens, token), "Not a watched token");
        }
        if (kind == ChangeKind.Allowance) {
            require(contains(contacts, contact), "Not a saved contact");
            require(value > 0, "An allowance can't be empty");
        }
        if (kind == ChangeKind.ContactAddress) {
            string storage name = nameOf[contact];
            require(bytes(name).length > 0, "Not a saved name");
            require(value != 0 && value <= type(uint160).max, "Not an address");
            require(IEnsDirectory(directory).addressOf(name) == address(uint160(value)), "The name doesn't point there");
            require(!contains(contacts, address(uint160(value))), "Already a saved contact");
        }
        require(waitingChanges < MAX_WAITING, "Too many changes waiting for your phone");
        waitingChanges++;
        id = changes.length;
        changes.push(Change(kind, contact, token, value, 0, 0, 0, false, false));
        emit ChangeProposed(id, kind, contact, token, value);
        publish(1, id);
    }

    function approve(uint256 id) external {
        require(msg.sender == rulesKey, "Only the rules key can approve");
        Change storage change = changeAt(id);
        require(!change.cancelled, "Change cancelled");
        require(change.readyAt == 0, "Already approved");
        waitingChanges--;
        uint256 readyAt = block.timestamp + looseningWait;
        uint256 expiresAt = readyAt + allowanceValidity;
        change.readyAt = readyAt;
        change.expiresAt = expiresAt;
        if (change.kind == ChangeKind.Allowance) {
            require(oldEnough(change.contact), "Contact too new for big payments");
            allowances[change.contact] = Allowance(change.token, change.value, readyAt, expiresAt, false);
            emit AllowanceCreated(change.contact, change.token, change.value, readyAt, expiresAt);
        } else if (change.kind != ChangeKind.ContactAddress) {
            change.valueBefore = currentValue(change.kind, change.token);
        }
        emit ChangeApproved(id, readyAt, expiresAt);
        publish(1, id);
    }

    function cancel(uint256 id) external {
        require(msg.sender == rulesKey, "Only the rules key can cancel");
        Change storage change = changeAt(id);
        require(!change.cancelled, "Change cancelled");
        require(!change.done, "Already switched on");
        change.cancelled = true;
        if (change.readyAt == 0) waitingChanges--;
        if (change.kind == ChangeKind.Allowance && change.readyAt != 0) {
            Allowance storage allowance = allowances[change.contact];
            require(allowance.activeFrom == change.readyAt && !allowance.used, "Allowance already used or replaced");
            delete allowances[change.contact];
        }
        emit ChangeCancelled(id);
        publish(1, id);
    }

    function switchOn(uint256 id) external {
        Change storage change = changeAt(id);
        require(change.kind != ChangeKind.Allowance, "Allowances switch on by themselves");
        require(!change.cancelled, "Change cancelled");
        require(change.readyAt != 0, "Not approved yet");
        require(!change.done, "Already switched on");
        require(block.timestamp >= change.readyAt, "Still waiting");
        require(block.timestamp <= change.expiresAt, "Change expired");
        change.done = true;
        if (change.kind == ChangeKind.ContactAddress) {
            repin(change.contact, address(uint160(change.value)));
        } else {
            require(currentValue(change.kind, change.token) == change.valueBefore, "This rule changed during the wait");
            writeValue(change.kind, change.token, change.value);
        }
        emit ChangeSwitchedOn(id);
        publish(1, id);
    }

    function payWithAllowance(address contact, uint256 amount) external {
        require(msg.sender == everydayKey, "Only the everyday key can pay");
        require(setupFinished, "Finish setting up first");
        Allowance storage allowance = allowances[contact];
        require(allowance.amount > 0, "No allowance for this contact");
        require(!allowance.used, "Allowance already used");
        require(block.timestamp >= allowance.activeFrom, "Allowance not active yet");
        require(block.timestamp <= allowance.expiresAt, "Allowance expired");
        require(amount <= allowance.amount, "More than the allowance");
        require(oldEnough(contact), "Contact too new for big payments");
        requireSameAddress(contact);
        allowance.used = true;
        emit AllowanceUsed(contact, allowance.token, amount);
        if (allowance.token == address(0)) {
            (bool ok,) = contact.call{value: amount}("");
            require(ok, "Payment failed");
        } else {
            require(IERC20(allowance.token).transfer(contact, amount), "Payment failed");
        }
    }

    function repin(address contact, address next) private {
        string memory name = nameOf[contact];
        require(IEnsDirectory(directory).addressOf(name) == next, "This contact's address changed");
        recordContact(next);
        pin(name, next);
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

    function changeCount() external view returns (uint256) {
        return changes.length;
    }

    function run(Action[] calldata actions, Check[] calldata checks, uint256 deadline) external {
        require(msg.sender == everydayKey, "Only the everyday key can run");
        require(setupFinished, "Finish setting up first");
        require(block.timestamp <= deadline, "Deadline passed");
        require(!running, "Already running");
        running = true;
        bytes32 accountBefore = fingerprint();
        Permission[] memory permissions = inspect(actions);
        uint256[] memory balancesBefore = measure(checks);
        uint256[] memory holdingsBefore = holdingsOf(address(this));
        (uint256[] memory tradedOut, uint256[] memory tradedIn) = execute(actions);
        verify(checks, balancesBefore);
        requireNoPermissionLeft(permissions);
        uint256[] memory holdingsAfter = holdingsOf(address(this));
        requireNothingElseLeft(checks, holdingsBefore, holdingsAfter);
        countTowardDailyLimits(holdingsBefore, holdingsAfter);
        countTowardNewContactLimits(actions);
        requireFairTrade(tradedOut, tradedIn);
        require(fingerprint() == accountBefore, "Your account would change");
        running = false;
        emit Ran(keccak256(abi.encode(actions)), keccak256(abi.encode(checks)), actions.length, deadline);
    }

    function inspect(Action[] calldata actions) private view returns (Permission[] memory permissions) {
        permissions = new Permission[](actions.length);
        KnownContracts memory known;
        for (uint256 i = 0; i < actions.length; i++) {
            permissions[i] = inspectOne(actions[i], known);
        }
    }

    function inspectOne(Action calldata action, KnownContracts memory known)
        private
        view
        returns (Permission memory none)
    {
        require(action.operation == 0, "Borrowed code would run in your account");
        if (action.data.length == 0) {
            require(contains(contacts, action.target), "Not a saved contact");
            requireSameAddress(action.target);
            return none;
        }
        if (contains(watchedTokens, action.target)) {
            require(action.data.length >= 4, "This kind of action isn't allowed");
            bytes4 selector = bytes4(action.data[:4]);
            if (selector == IERC20.transfer.selector) {
                (address to,) = abi.decode(action.data[4:], (address, uint256));
                require(contains(contacts, to), "Not a saved contact");
                requireSameAddress(to);
                return none;
            }
            require(selector == IERC20.approve.selector, "This kind of action isn't allowed");
            (address spender,) = abi.decode(action.data[4:], (address, uint256));
            require(spender == PERMIT2 || isKnown(known, spender), "Permission for an untrusted contract");
            return Permission(action.target, spender, false);
        }
        if (action.target == PERMIT2) {
            require(action.data.length >= 4 && bytes4(action.data[:4]) == IPermit2.approve.selector, "This kind of action isn't allowed");
            (address token, address spender,,) = abi.decode(action.data[4:], (address, address, uint160, uint48));
            require(isKnown(known, spender), "Permission for an untrusted contract");
            return Permission(token, spender, true);
        }
        require(isKnown(known, action.target), "Not a trusted contract");
    }

    function isKnown(KnownContracts memory known, address account) private view returns (bool) {
        if (!known.read) {
            known.list = IEnsDirectory(directory).listed();
            known.read = true;
        }
        for (uint256 i = 0; i < known.list.length; i++) {
            if (known.list[i] == account) return true;
        }
        return false;
    }

    function execute(Action[] calldata actions) private returns (uint256[] memory tradedOut, uint256[] memory tradedIn) {
        tradedOut = new uint256[](watchedTokens.length + 1);
        tradedIn = new uint256[](watchedTokens.length + 1);
        for (uint256 i = 0; i < actions.length; i++) {
            bool trade = !isPayment(actions[i]);
            uint256[] memory before;
            if (trade) before = holdingsOf(address(this));
            (bool ok,) = actions[i].target.call{value: actions[i].value}(actions[i].data);
            require(ok, "An action failed");
            if (trade) countTrade(before, holdingsOf(address(this)), tradedOut, tradedIn);
        }
    }

    function isPayment(Action calldata action) private view returns (bool) {
        if (action.data.length == 0) return true;
        return contains(watchedTokens, action.target) && bytes4(action.data[:4]) == IERC20.transfer.selector;
    }

    function paymentOf(Action calldata action) private view returns (address to, uint256 tokenIndex, uint256 amount) {
        if (action.data.length == 0) return (action.target, 0, action.value);
        (to, amount) = abi.decode(action.data[4:], (address, uint256));
        tokenIndex = indexOf(action.target);
    }

    function countTrade(
        uint256[] memory before,
        uint256[] memory afterwards,
        uint256[] memory tradedOut,
        uint256[] memory tradedIn
    ) private pure {
        for (uint256 j = 0; j < afterwards.length; j++) {
            if (afterwards[j] < before[j]) tradedOut[j] += before[j] - afterwards[j];
            else tradedIn[j] += afterwards[j] - before[j];
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

    function countTowardNewContactLimits(Action[] calldata actions) private {
        for (uint256 i = 0; i < actions.length; i++) {
            if (!isPayment(actions[i])) continue;
            (address to, uint256 j, uint256 amount) = paymentOf(actions[i]);
            if (!isNew(to)) continue;
            receivedWhileNew[to][j] += amount;
            require(receivedWhileNew[to][j] <= newContactLimits[j], "Over the new-contact limit");
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

    function requireFairTrade(uint256[] memory tradedOut, uint256[] memory tradedIn) private view {
        bool tradedAway = false;
        for (uint256 i = 0; i < tradedOut.length; i++) {
            if (tradedOut[i] > tradedIn[i]) tradedAway = true;
        }
        if (!tradedAway) return;
        require(priceSource != address(0), "No fair price available");
        uint256 valueOut = 0;
        uint256 valueIn = 0;
        for (uint256 i = 0; i < tradedOut.length; i++) {
            address token = i == 0 ? address(0) : watchedTokens[i - 1];
            if (tradedOut[i] > tradedIn[i]) {
                valueOut += IPriceSource(priceSource).valueOf(token, tradedOut[i] - tradedIn[i]);
            } else if (tradedIn[i] > tradedOut[i]) {
                valueIn += IPriceSource(priceSource).valueOf(token, tradedIn[i] - tradedOut[i]);
            }
        }
        require(valueIn * 10_000 >= valueOut * (10_000 - tradeTolerance), "Unfair trade");
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

    function changeAt(uint256 id) private view returns (Change storage) {
        require(id < changes.length, "No such change");
        return changes[id];
    }

    function changeRule(ChangeKind kind, address token, uint256 value) private {
        require(!setupFinished || !loosens(kind, currentValue(kind, token), value), "Loosening needs a proposal");
        writeValue(kind, token, value);
    }

    function loosens(ChangeKind kind, uint256 current, uint256 next) private pure returns (bool) {
        if (kind == ChangeKind.PriceSource) return next != current;
        if (kind == ChangeKind.NewContactPeriod || kind == ChangeKind.AllowanceMinAge || kind == ChangeKind.LooseningWait) {
            return next < current;
        }
        return next > current;
    }

    function currentValue(ChangeKind kind, address token) private view returns (uint256) {
        if (kind == ChangeKind.DailyLimit) return dailyLimits[indexOf(token)];
        if (kind == ChangeKind.NewContactLimit) return newContactLimits[indexOf(token)];
        if (kind == ChangeKind.AllowanceValidity) return allowanceValidity;
        if (kind == ChangeKind.NewContactPeriod) return newContactPeriod;
        if (kind == ChangeKind.AllowanceMinAge) return allowanceMinAge;
        if (kind == ChangeKind.LooseningWait) return looseningWait;
        if (kind == ChangeKind.TradeTolerance) return tradeTolerance;
        if (kind == ChangeKind.PriceSource) return uint256(uint160(priceSource));
        revert("Not a rule");
    }

    function writeValue(ChangeKind kind, address token, uint256 value) private {
        if (kind == ChangeKind.DailyLimit) {
            dailyLimits[indexOf(token)] = value;
            emit DailyLimitSet(token, value);
        } else if (kind == ChangeKind.NewContactLimit) {
            newContactLimits[indexOf(token)] = value;
            emit NewContactLimitSet(token, value);
        } else if (kind == ChangeKind.AllowanceValidity) {
            allowanceValidity = value;
            emit AllowanceValiditySet(value);
        } else if (kind == ChangeKind.NewContactPeriod) {
            newContactPeriod = value;
            emit NewContactPeriodSet(value);
        } else if (kind == ChangeKind.AllowanceMinAge) {
            allowanceMinAge = value;
            emit AllowanceMinAgeSet(value);
        } else if (kind == ChangeKind.LooseningWait) {
            looseningWait = value;
            emit LooseningWaitSet(value);
        } else if (kind == ChangeKind.TradeTolerance) {
            require(value <= 10_000, "Tolerance can't be over 100%");
            tradeTolerance = value;
            emit TradeToleranceSet(value);
        } else if (kind == ChangeKind.PriceSource) {
            require(value <= type(uint160).max, "Not an address");
            priceSource = address(uint160(value));
            emit PriceSourceSet(priceSource);
        } else {
            revert("Not a rule");
        }
        publish(0, 0);
    }

    function hasLimit(Check[] calldata checks, address token) private pure returns (bool) {
        for (uint256 i = 0; i < checks.length; i++) {
            if (checks[i].kind == CheckKind.AtMostLeaves && checks[i].token == token) return true;
        }
        return false;
    }

    function fingerprint() private view returns (bytes32) {
        address[] memory watched = watchedTokens;
        address[] memory saved = contacts;
        uint256[] memory limits = dailyLimits;
        uint256[] memory newLimits = newContactLimits;
        Allowance[] memory given = new Allowance[](saved.length);
        uint256[] memory ages = new uint256[](saved.length);
        for (uint256 i = 0; i < saved.length; i++) {
            given[i] = allowances[saved[i]];
            ages[i] = savedAt[saved[i]];
        }
        bytes32 settings = keccak256(
            abi.encode(
                limits,
                newLimits,
                allowanceValidity,
                newContactPeriod,
                allowanceMinAge,
                looseningWait,
                setupFinished,
                tradeTolerance,
                priceSource
            )
        );
        return keccak256(abi.encode(everydayKey, rulesKey, watched, directory, saved, given, ages, settings, address(this).codehash));
    }

    function contains(address[] storage list, address item) private view returns (bool) {
        for (uint256 i = 0; i < list.length; i++) {
            if (list[i] == item) return true;
        }
        return false;
    }
}

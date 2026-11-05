// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IUniversalResolver {
    function findResolver(bytes calldata name) external view returns (address resolver, bytes32 node, uint256 offset);
}

interface IExtendedResolver {
    function resolve(bytes calldata name, bytes calldata data) external view returns (bytes memory);
}

interface IAddressResolver {
    function addr(bytes32 node, uint256 coinType) external view returns (bytes memory);
}

interface IVerifiableFactory {
    function verifyContract(address proxy) external view returns (address implementation);
}

interface ITextResolver {
    function setText(bytes calldata name, string calldata key, string calldata value) external;
}

interface ITokenInfo {
    function symbol() external view returns (string memory);
    function decimals() external view returns (uint8);
}

interface IVaultRecords {
    function ensName() external view returns (string memory);
    function watchedTokens(uint256 index) external view returns (address);
    function dailyLimit(address token) external view returns (uint256);
    function newContactLimit(address token) external view returns (uint256);
    function allowanceValidity() external view returns (uint256);
    function newContactPeriod() external view returns (uint256);
    function allowanceMinAge() external view returns (uint256);
    function looseningWait() external view returns (uint256);
    function tradeTolerance() external view returns (uint256);
    function priceSource() external view returns (address);
    function changeCount() external view returns (uint256);
    function nameOf(address contact) external view returns (string memory);
    function changes(uint256 id)
        external
        view
        returns (
            uint8 kind,
            address contact,
            address token,
            uint256 value,
            uint256 valueBefore,
            uint256 readyAt,
            uint256 expiresAt,
            bool cancelled,
            bool done
        );
}

contract EnsDirectory {
    uint256 private constant ETH_COIN_TYPE = 60;

    IUniversalResolver public immutable universalResolver;
    IVerifiableFactory public immutable verifiableFactory;
    address public immutable resolverImplementation;
    string[] public names;
    bytes[] private encodedNames;

    constructor(
        IUniversalResolver universalResolver_,
        IVerifiableFactory verifiableFactory_,
        address resolverImplementation_,
        string[] memory names_
    ) {
        universalResolver = universalResolver_;
        verifiableFactory = verifiableFactory_;
        resolverImplementation = resolverImplementation_;
        for (uint256 i = 0; i < names_.length; i++) {
            names.push(names_[i]);
            encodedNames.push(dnsEncode(names_[i]));
        }
    }

    function nameCount() external view returns (uint256) {
        return names.length;
    }

    function addressOf(string calldata name) external view returns (address) {
        return read(dnsEncode(name));
    }

    function resolverOf(string calldata name) external view returns (address) {
        try universalResolver.findResolver(dnsEncode(name)) returns (address resolver, bytes32, uint256 offset) {
            return resolver != address(0) && offset == 0 && isGenuine(resolver) ? resolver : address(0);
        } catch {
            return address(0);
        }
    }

    function records(address vault, uint256 kind, uint256 detail) external view returns (bytes[] memory calls) {
        IVaultRecords source = IVaultRecords(vault);
        bytes memory name = dnsEncode(source.ensName());
        if (kind == 0) return ruleRecords(source, name);
        if (kind == 1) {
            calls = new bytes[](2);
            calls[0] = textRecord(name, string.concat("verbatim.change.", decimal(detail)), changeRecord(source, detail));
            calls[1] = textRecord(name, "verbatim.changeCount", decimal(source.changeCount()));
            return calls;
        }
        address contact = address(uint160(detail));
        calls = new bytes[](1);
        calls[0] = textRecord(name, string.concat("verbatim.contact.", source.nameOf(contact)), hexString(contact));
    }

    function isListed(address account) external view returns (bool) {
        if (account == address(0)) return false;
        for (uint256 i = 0; i < encodedNames.length; i++) {
            if (read(encodedNames[i]) == account) return true;
        }
        return false;
    }

    function listed() external view returns (address[] memory found) {
        address[] memory all = new address[](encodedNames.length);
        uint256 count = 0;
        for (uint256 i = 0; i < encodedNames.length; i++) {
            address account = read(encodedNames[i]);
            if (account != address(0)) all[count++] = account;
        }
        found = new address[](count);
        for (uint256 i = 0; i < count; i++) {
            found[i] = all[i];
        }
    }

    function read(bytes memory name) private view returns (address) {
        try universalResolver.findResolver(name) returns (address resolver, bytes32 node, uint256 offset) {
            if (resolver == address(0) || offset != 0 || !isGenuine(resolver)) return address(0);
            try IExtendedResolver(resolver).resolve(name, abi.encodeCall(IAddressResolver.addr, (node, ETH_COIN_TYPE))) returns (
                bytes memory result
            ) {
                bytes memory value = abi.decode(result, (bytes));
                return value.length == 20 ? address(bytes20(value)) : address(0);
            } catch {
                return address(0);
            }
        } catch {
            return address(0);
        }
    }

    function isGenuine(address resolver) private view returns (bool) {
        try verifiableFactory.verifyContract(resolver) returns (address implementation) {
            return implementation == resolverImplementation;
        } catch {
            return false;
        }
    }

    function ruleRecords(IVaultRecords source, bytes memory name) private view returns (bytes[] memory calls) {
        address[] memory tokens = holdingsOf(source);
        uint256 n = tokens.length * 2;
        calls = new bytes[](n + 6);
        for (uint256 i = 0; i < tokens.length; i++) {
            string memory symbol = symbolOf(tokens[i]);
            calls[2 * i] = textRecord(name, string.concat("verbatim.dailyLimit.", symbol), amount(tokens[i], source.dailyLimit(tokens[i])));
            calls[2 * i + 1] =
                textRecord(name, string.concat("verbatim.newContactLimit.", symbol), amount(tokens[i], source.newContactLimit(tokens[i])));
        }
        calls[n] = textRecord(name, "verbatim.allowanceValidity", duration(source.allowanceValidity()));
        calls[n + 1] = textRecord(name, "verbatim.newContactPeriod", duration(source.newContactPeriod()));
        calls[n + 2] = textRecord(name, "verbatim.allowanceMinAge", duration(source.allowanceMinAge()));
        calls[n + 3] = textRecord(name, "verbatim.looseningWait", duration(source.looseningWait()));
        calls[n + 4] = textRecord(name, "verbatim.tradeTolerance", percent(source.tradeTolerance()));
        address prices = source.priceSource();
        calls[n + 5] = textRecord(name, "verbatim.priceSource", prices == address(0) ? "none" : hexString(prices));
    }

    function changeRecord(IVaultRecords source, uint256 id) private view returns (string memory) {
        (uint8 kind, address contact, address token, uint256 value,, uint256 readyAt, uint256 expiresAt, bool cancelled, bool done) =
            source.changes(id);
        string memory status = cancelled ? "cancelled" : done ? "switched on" : readyAt == 0 ? "proposed" : "approved";
        return string.concat(
            "{\"id\":",
            decimal(id),
            ",\"kind\":",
            decimal(kind),
            ",\"change\":\"",
            describe(source, kind, contact, token, value),
            "\",\"status\":\"",
            status,
            "\",\"readyAt\":",
            decimal(readyAt),
            ",\"expiresAt\":",
            decimal(expiresAt),
            "}"
        );
    }

    function describe(IVaultRecords source, uint8 kind, address contact, address token, uint256 value)
        private
        view
        returns (string memory)
    {
        if (kind == 0) return string.concat("Daily limit for ", symbolOf(token), ": ", amount(token, value));
        if (kind == 1) return string.concat("New-contact limit for ", symbolOf(token), ": ", amount(token, value));
        if (kind == 2) return string.concat("One payment of up to ", amount(token, value), " to ", contactName(source, contact));
        if (kind == 3) return string.concat("Approved changes stay valid for ", duration(value));
        if (kind == 4) return string.concat("Contacts count as new for ", duration(value));
        if (kind == 5) return string.concat("One-off payments only to contacts saved at least ", duration(value), " ago");
        if (kind == 6) return string.concat("Changes wait ", duration(value), " before they can switch on");
        if (kind == 7) return string.concat("Trades may be up to ", percent(value), " below the fair price");
        if (kind == 8) return string.concat("Price source: ", hexString(address(uint160(value))));
        return string.concat(contactName(source, contact), " moves to ", hexString(address(uint160(value))));
    }

    function contactName(IVaultRecords source, address contact) private view returns (string memory) {
        string memory name = source.nameOf(contact);
        return bytes(name).length > 0 ? name : hexString(contact);
    }

    function holdingsOf(IVaultRecords source) private view returns (address[] memory tokens) {
        uint256 count = 0;
        while (true) {
            try source.watchedTokens(count) returns (address) {
                count++;
            } catch {
                break;
            }
        }
        tokens = new address[](count + 1);
        for (uint256 i = 0; i < count; i++) {
            tokens[i + 1] = source.watchedTokens(i);
        }
    }

    function textRecord(bytes memory name, string memory key, string memory value) private pure returns (bytes memory) {
        return abi.encodeCall(ITextResolver.setText, (name, key, value));
    }

    function symbolOf(address token) private view returns (string memory) {
        if (token == address(0)) return "ETH";
        try ITokenInfo(token).symbol() returns (string memory symbol) {
            return symbol;
        } catch {
            return hexString(token);
        }
    }

    function decimalsOf(address token) private view returns (uint256) {
        if (token == address(0)) return 18;
        try ITokenInfo(token).decimals() returns (uint8 places) {
            return places;
        } catch {
            return 0;
        }
    }

    function amount(address token, uint256 value) private view returns (string memory) {
        uint256 places = decimalsOf(token);
        uint256 unit = 10 ** places;
        string memory whole = decimal(value / unit);
        uint256 rest = value % unit;
        if (rest == 0) return string.concat(whole, " ", symbolOf(token));
        bytes memory digits = bytes(decimal(rest + unit));
        uint256 end = digits.length;
        while (digits[end - 1] == "0") end--;
        bytes memory fraction = new bytes(end - 1);
        for (uint256 i = 1; i < end; i++) {
            fraction[i - 1] = digits[i];
        }
        return string.concat(whole, ".", string(fraction), " ", symbolOf(token));
    }

    function duration(uint256 secondsCount) private pure returns (string memory) {
        if (secondsCount > 0 && secondsCount % 1 days == 0) return plural(secondsCount / 1 days, "day");
        if (secondsCount > 0 && secondsCount % 1 hours == 0) return plural(secondsCount / 1 hours, "hour");
        if (secondsCount > 0 && secondsCount % 1 minutes == 0) return plural(secondsCount / 1 minutes, "minute");
        return plural(secondsCount, "second");
    }

    function plural(uint256 count, string memory unit) private pure returns (string memory) {
        return string.concat(decimal(count), " ", unit, count == 1 ? "" : "s");
    }

    function percent(uint256 basisPoints) private pure returns (string memory) {
        uint256 rest = basisPoints % 100;
        if (rest == 0) return string.concat(decimal(basisPoints / 100), "%");
        string memory fraction = rest % 10 == 0 ? decimal(rest / 10) : rest < 10 ? string.concat("0", decimal(rest)) : decimal(rest);
        return string.concat(decimal(basisPoints / 100), ".", fraction, "%");
    }

    function decimal(uint256 value) private pure returns (string memory) {
        if (value == 0) return "0";
        uint256 length = 0;
        for (uint256 rest = value; rest > 0; rest /= 10) {
            length++;
        }
        bytes memory digits = new bytes(length);
        for (uint256 i = length; i > 0; i--) {
            digits[i - 1] = bytes1(uint8(48 + (value % 10)));
            value /= 10;
        }
        return string(digits);
    }

    function hexString(address account) private pure returns (string memory) {
        bytes memory symbols = "0123456789abcdef";
        bytes memory result = new bytes(42);
        result[0] = "0";
        result[1] = "x";
        uint160 value = uint160(account);
        for (uint256 i = 41; i > 1; i--) {
            result[i] = symbols[value & 0xf];
            value >>= 4;
        }
        return string(result);
    }

    function dnsEncode(string memory name) private pure returns (bytes memory encoded) {
        bytes memory text = bytes(name);
        require(text.length > 0, "A name can't be empty");
        encoded = new bytes(text.length + 2);
        uint256 start = 0;
        for (uint256 i = 0; i <= text.length; i++) {
            if (i < text.length && text[i] != ".") continue;
            uint256 size = i - start;
            require(size > 0 && size < 64, "Each part of a name must be 1 to 63 characters");
            encoded[start] = bytes1(uint8(size));
            for (uint256 j = start; j < i; j++) {
                encoded[j + 1] = text[j];
            }
            start = i + 1;
        }
    }
}

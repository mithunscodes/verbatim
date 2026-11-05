// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {VerbatimVault} from "../src/VerbatimVault.sol";

contract ReentryKey {
    VerbatimVault public vault;
    string public reason;

    function setVault(VerbatimVault vault_) external {
        vault = vault_;
    }

    function start(VerbatimVault.Action[] calldata actions, uint256 deadline) external {
        vault.run(actions, new VerbatimVault.Check[](0), deadline);
    }

    function reenter() external {
        try vault.run(new VerbatimVault.Action[](0), new VerbatimVault.Check[](0), block.timestamp) {
            reason = "Not blocked";
        } catch Error(string memory why) {
            reason = why;
        }
    }
}

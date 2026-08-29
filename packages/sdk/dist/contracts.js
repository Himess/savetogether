"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ghostKey = ghostKey;
exports.erc7984 = erc7984;
exports.acl = acl;
/**
 * Typed facades over ethers' dynamic `Contract`.
 *
 * `Contract` exposes its methods through an index signature, which under
 * `noUncheckedIndexedAccess` types every call as possibly-undefined. Rather than
 * sprinkle non-null assertions across the call sites, the surface each contract
 * actually offers is declared once, here, and the `Contract` is cast to it. That
 * also makes this file the single place where the SDK's assumptions about the
 * on-chain ABI are written down.
 */
const ethers_1 = require("ethers");
const abi_1 = require("./abi");
function ghostKey(address, runner) {
    return new ethers_1.Contract(address, abi_1.GHOSTKEY_ABI, runner);
}
function erc7984(address, runner) {
    return new ethers_1.Contract(address, abi_1.ERC7984_ABI, runner);
}
function acl(address, runner) {
    return new ethers_1.Contract(address, abi_1.ACL_ABI, runner);
}
//# sourceMappingURL=contracts.js.map
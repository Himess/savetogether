/**
 * P1 — does the hosted handshake actually work, in the order the architecture
 * needs it to?
 *
 * `openSession` recovers `sessionKeySignature` and requires it to equal
 * `params.sessionKey` (SaveTogetherSession.sol:133), and the digest binds
 * (owner, sessionKey, expiry, maxTxCount) (SaveTogetherSession.sol:381). So the key
 * must exist before the user signs anything, and the server must already know
 * the user's address when it signs. That is one round trip only if the browser's
 * opening request carries the address — which is the thing this proves.
 *
 * Nothing here uses the file keystore. The session key is generated in memory,
 * the way a server would hold it, and the owner is a different wallet that only
 * ever sends a transaction.
 *
 *   npx hardhat run spikes/p1-handshake.ts --network sepolia
 */
import { ethers, fhevm } from "hardhat";
import { Wallet, recoverAddress } from "ethers";
import * as fs from "fs";
import * as path from "path";

const MODULE = "0xE5c667c0C58242f89ee59f9269111A3EfB836Cf6";
const TOKEN = "0x1bbBE55d24174d57305632E75fE47ac3C5158a9F"; // gUSDC, whole units

const MODULE_ABI = [
  "function openSession((address sessionKey,uint48 expiry,uint24 maxTxCount,address[] tokens,bytes32[] budgets,address[] recipients) params, bytes inputProof, bytes sessionKeySignature)",
  "function openSessionDigest(address owner, address sessionKey, uint48 expiry, uint24 maxTxCount) view returns (bytes32)",
  "function sessionOf(address sessionKey) view returns ((address owner,uint48 expiry,uint24 maxTxCount,uint24 txCount))",
  "function closeSession(address sessionKey)",
  "function send(address token, address to, bytes32 encAmount, bytes inputProof)",
  "function remainingOf(address sessionKey, address token) view returns (bytes32)",
];
const TOKEN_ABI = [
  "function mint(address to, uint64 amount) returns (bytes32)",
  "function setOperator(address operator, uint48 until)",
  "function confidentialBalanceOf(address) view returns (bytes32)",
];

const EIP712_TYPES = {
  OpenSession: [
    { name: "owner", type: "address" },
    { name: "sessionKey", type: "address" },
    { name: "expiry", type: "uint48" },
    { name: "maxTxCount", type: "uint24" },
  ],
};

const out: Record<string, unknown> = {};

async function main(): Promise<void> {
  await fhevm.initializeCLIApi();
  const [owner] = await ethers.getSigners();
  const ownerAddress = await owner!.getAddress();
  const provider = ethers.provider;
  const chainId = Number((await provider.getNetwork()).chainId);

  console.log(`owner (the browser wallet)  ${ownerAddress}`);
  console.log(`module                      ${MODULE}`);
  if ((await provider.getCode(MODULE)) === "0x") throw new Error("no module at that address");

  const module = new ethers.Contract(MODULE, MODULE_ABI, owner!);
  const token = new ethers.Contract(TOKEN, TOKEN_ABI, owner!);

  const expiry = Math.floor(Date.now() / 1000) + 24 * 3600;
  const maxTxCount = 0;
  const budget = 500n;

// Measured, not guessed: 0.002 ETH was not enough for one send on Sepolia at
// the gas price of the day -- the node wanted 2,061,613,338,822,928 wei. The
// hosted batch has to forward enough for the session to be usable at all, so
// this figure is a design input rather than a test detail.
const SESSION_KEY_GAS = ethers.parseEther("0.01");

  // ---------------------------------------------------------------- step 2 --
  // Everything in this block is what the SERVER does, holding no user key and
  // never being asked for one. It needs the owner's ADDRESS and nothing else.
  console.log(`\n2. server side — generate the key and sign, knowing only the address`);

  const sessionKey = Wallet.createRandom().connect(provider);
  const sessionKeyAddress = await sessionKey.getAddress();
  console.log(`   session key      ${sessionKeyAddress}  (in memory, no keystore)`);

  // The budget ciphertext binds to (contract, owner). Creating it needs the
  // owner's address, NOT the owner's key -- so the server can build it and the
  // browser never has to run the WASM prover during a session open.
  const enc = await fhevm.createEncryptedInput(MODULE, ownerAddress).add64(budget).encrypt();
  console.log(`   budget ciphertext built for the owner, without the owner's key`);

  const signature = await sessionKey.signTypedData(
    { name: "SaveTogetherSession", version: "1", chainId, verifyingContract: MODULE },
    EIP712_TYPES,
    { owner: ownerAddress, sessionKey: sessionKeyAddress, expiry, maxTxCount },
  );

  // The contract's own digest must be what was signed. A domain mismatch here is
  // silent until the transaction reverts, so it is checked before sending.
  const digest: string = await module.openSessionDigest!(
    ownerAddress,
    sessionKeyAddress,
    expiry,
    maxTxCount,
  );
  const recovered = recoverAddress(digest, signature);
  console.log(`   digest recovers to ${recovered}`);
  if (recovered.toLowerCase() !== sessionKeyAddress.toLowerCase()) {
    throw new Error("the signature does not recover against the contract's digest");
  }
  console.log(`   => the server can sign the opener's digest before the user touches anything`);

  // ---------------------------------------------------------------- step 3 --
  console.log(`\n3-4. browser side — one wallet, the calls the server handed back`);
  await (await token.mint!(ownerAddress, 5_000n)).wait();

  const calls = [
    { to: TOKEN, data: token.interface.encodeFunctionData("setOperator", [MODULE, expiry]) },
    {
      to: MODULE,
      data: module.interface.encodeFunctionData("openSession", [
        {
          sessionKey: sessionKeyAddress,
          expiry,
          maxTxCount,
          tokens: [TOKEN],
          budgets: [enc.handles[0]],
          // The session key is always on its own allowlist: it is the address a
          // pool position is held under, and funding it is an ordinary
          // budget-bounded send.
          recipients: [sessionKeyAddress],
        },
        enc.inputProof,
        signature,
      ]),
    },
  ];

  const hashes: string[] = [];
  for (const c of calls) {
    const tx = await owner!.sendTransaction(c);
    await tx.wait();
    hashes.push(tx.hash);
    console.log(`   sent ${tx.hash}`);
  }

  // ---------------------------------------------------------------- step 6 --
  console.log(`\n6. server side — adopt only what the chain confirms`);
  const s = await module.sessionOf!(sessionKeyAddress);
  console.log(`   sessionOf(${sessionKeyAddress.slice(0, 10)}...).owner = ${s.owner}`);
  const adopted = s.owner.toLowerCase() === ownerAddress.toLowerCase() && s.expiry > 0n;
  console.log(`   claim by the real owner   ${adopted ? "ACCEPTED" : "REJECTED"}`);

  const impostor = Wallet.createRandom().address;
  const impostorOk = s.owner.toLowerCase() === impostor.toLowerCase();
  console.log(`   claim by a stranger       ${impostorOk ? "ACCEPTED — BUG" : "REJECTED"}`);

  // ------------------------------------------------------------ the point ---
  console.log(`\n   does the server-held key actually work?`);
  await (await owner!.sendTransaction({ to: sessionKeyAddress, value: SESSION_KEY_GAS })).wait();

  const sendEnc = await fhevm
    .createEncryptedInput(MODULE, sessionKeyAddress)
    .add64(100n)
    .encrypt();
  const sendTx = await module
    .connect(sessionKey)
    // @ts-expect-error runtime contract
    .send(TOKEN, sessionKeyAddress, sendEnc.handles[0], sendEnc.inputProof);
  await sendTx.wait();
  console.log(`   send from the session key ${sendTx.hash}`);

  // ------------------------------------------------------------------ P2 ---
  console.log(`\nP2. the user kills it from their own wallet`);
  const closeTx = await module.closeSession!(sessionKeyAddress);
  await closeTx.wait();
  const after = await module.sessionOf!(sessionKeyAddress);
  console.log(`   closeSession ${closeTx.hash}`);
  console.log(`   expiry now ${after.expiry}  ${after.expiry === 0n ? "(dead)" : "(STILL LIVE)"}`);

  let deadKeyRejected = false;
  try {
    const e2 = await fhevm.createEncryptedInput(MODULE, sessionKeyAddress).add64(1n).encrypt();
    // @ts-expect-error runtime contract
    await module.connect(sessionKey).send.staticCall(TOKEN, sessionKeyAddress, e2.handles[0], e2.inputProof);
  } catch {
    deadKeyRejected = true;
  }
  console.log(`   the dead key can still spend: ${deadKeyRejected ? "no" : "YES — BUG"}`);

  Object.assign(out, {
    ownerAddress,
    sessionKeyAddress,
    openHashes: hashes,
    sendHash: sendTx.hash,
    closeHash: closeTx.hash,
    adopted,
    impostorRejected: !impostorOk,
    deadKeyRejected,
  });
  fs.mkdirSync(path.join(__dirname, "out"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, "out", "p1-handshake.json"), JSON.stringify(out, null, 2));
  console.log(`\nwritten to spikes/out/p1-handshake.json`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

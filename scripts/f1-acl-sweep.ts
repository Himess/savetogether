/**
 * F1 — the under-granting sweep.
 *
 * AA1 searched for handles granted to too MANY readers. This searches the other
 * direction: handles a getter hands out that the intended reader cannot decrypt,
 * because no `FHE.allow` ever named them.
 *
 * `pendingOf` was found that way, and it read correctly in pre-flight only by
 * coincidence — while `_pending` and `_winnings` had accumulated the identical
 * sequence from zero, `tryAdd` produced the same handle for both, so the
 * winnings grant covered pending too. The first `_drain` diverged them and the
 * accident ended. The same coincidence could still be masking others, so every
 * externally-readable handle is decrypted here rather than reasoned about.
 *
 *   npx hardhat run scripts/f1-acl-sweep.ts --network sepolia
 */
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";

/** `userDecryptEuint` accepts only the euint members of `FhevmType`. */
type EuintType = Parameters<typeof fhevm.userDecryptEuint>[0];
import * as fs from "fs";

const POOL = "0x894F6492357277CF36e9973787663AE9F73387BE";
const SRC = "0xB16EB979231A95C2Ad454Ebd456b4c5AD23811Ba";
const SESSION = "0xE5c667c0C58242f89ee59f9269111A3EfB836Cf6";

type Row = {
  contract: string;
  getter: string;
  intendedReader: string;
  handle: string;
  readable: boolean | null;
  value?: string;
  verdict: string;
};

async function main(): Promise<void> {
  await fhevm.initializeCLIApi();
  const [s] = await ethers.getSigners();
  const me = await s!.getAddress();
  console.log(`sweeping as ${me}\n`);

  const pool = await ethers.getContractAt("ConfidentialPrizePool", POOL, s!);
  const src = await ethers.getContractAt("SteakhouseReplicaSource", SRC, s!);
  const rows: Row[] = [];

  const probe = async (
    contract: string,
    at: string,
    getter: string,
    intendedReader: string,
    handle: string,
    type: EuintType = FhevmType.euint64 as EuintType,
  ): Promise<void> => {
    if (!handle || handle === ethers.ZeroHash) {
      rows.push({ contract, getter, intendedReader, handle, readable: null, verdict: "uninitialised — inconclusive" });
      console.log(`  ${getter.padEnd(26)} uninitialised`);
      return;
    }
    try {
      const v = (await fhevm.userDecryptEuint(type, handle, at, s!)) as bigint;
      rows.push({ contract, getter, intendedReader, handle, readable: true, value: v.toString(), verdict: "granted" });
      console.log(`  ${getter.padEnd(26)} READABLE  ${v}`);
    } catch (e) {
      const why = String(e).split("\n")[0]!.slice(0, 60);
      rows.push({ contract, getter, intendedReader, handle, readable: false, verdict: `NOT GRANTED — ${why}` });
      console.log(`  ${getter.padEnd(26)} NOT READABLE`);
    }
  };

  console.log("ConfidentialPrizePool — handles a holder is meant to read:");
  await probe("ConfidentialPrizePool", POOL, "confidentialBalanceOf(me)", "the holder", await pool.confidentialBalanceOf!(me));
  await probe("ConfidentialPrizePool", POOL, "winningsOf(me)", "the holder", await pool.winningsOf!(me));
  await probe("ConfidentialPrizePool", POOL, "pendingOf(me)", "the holder", await pool.pendingOf!(me));
  await probe("ConfidentialPrizePool", POOL, "reserveHandle()", "unclear — no caller", await pool.reserveHandle!());

  // weightFor and cumulativeAt grant on call, so they must be invoked first.
  const n = Number(await pool.drawCount!());
  await (await pool.weightFor!(n, me)).wait();
  await probe("ConfidentialPrizePool", POOL, `weightFor(${n}, me)`, "the holder", await pool.weightFor!.staticCall(n, me), FhevmType.euint128);
  const ts = Math.floor(Date.now() / 1000) - 60;
  await (await pool.cumulativeAt!(me, ts)).wait();
  await probe("ConfidentialPrizePool", POOL, "cumulativeAt(me, t)", "the holder", await pool.cumulativeAt!.staticCall(me, ts), FhevmType.euint128);

  console.log("\nSteakhouseReplicaSource — handles its getters hand out:");
  await probe("SteakhouseReplicaSource", SRC, "principal()", "unclear — in the ABI", await src.principal!());
  await probe("SteakhouseReplicaSource", SRC, "pending()", "unclear — in the ABI", await src.pending!());
  await probe("SteakhouseReplicaSource", SRC, "inVault()", "unclear — in the ABI", await src.inVault!());

  console.log("\nSaveTogetherSession — the budget, read as its owner:");
  const session = await ethers.getContractAt("SaveTogetherSession", SESSION, s!);
  try {
    const CUSDC = "0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639";
    // No live session for this signer is expected; the getter is still probed so
    // an initialised one would be caught.
    const h = await session.remainingOf!(me, CUSDC);
    await probe("SaveTogetherSession", SESSION, "remainingOf(me, cUSDC)", "owner and session key", h);
  } catch (e) {
    console.log(`  remainingOf                skipped — ${String(e).split("\n")[0]!.slice(0, 60)}`);
  }

  const notGranted = rows.filter((r) => r.readable === false);
  console.log("\n================= SWEEP RESULT =================");
  console.log(`${rows.length} handles probed, ${rows.filter((r) => r.readable === true).length} readable, ` +
    `${notGranted.length} NOT readable, ${rows.filter((r) => r.readable === null).length} inconclusive`);
  if (notGranted.length) {
    console.log("\nUnder-granted:");
    for (const r of notGranted) console.log(`  ${r.contract}.${r.getter}  (intended reader: ${r.intendedReader})`);
  }

  fs.mkdirSync("out", { recursive: true });
  fs.writeFileSync("out/f1-acl-sweep.json", JSON.stringify({ at: new Date().toISOString(), signer: me, rows }, null, 2));
  console.log("\nwrote out/f1-acl-sweep.json");
}

main().catch((e) => {
  console.error(String(e).split("\n").slice(0, 4).join("\n"));
  process.exitCode = 1;
});

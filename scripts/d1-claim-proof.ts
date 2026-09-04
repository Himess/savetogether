/**
 * D1 follow-up — prove `claim` actually moves value.
 *
 * The first cycle ran `claim` and it succeeded, but it drained nothing: the
 * deposit two steps earlier had already folded the pending credit in, because
 * `deposit` calls `_drain` too. A transaction that succeeds while doing nothing
 * is not evidence that the path works.
 *
 * This runs harvest -> openDraw -> reveal -> accrue until the account actually
 * wins something, then claims with a non-zero pending credit and shows the
 * position move. Harvest matters: without it the reserve is empty and a win is
 * credited zero, which is the documented silent under-payment.
 *
 *   npx hardhat run scripts/d1-claim-proof.ts --network sepolia
 */
import { ethers, fhevm } from "hardhat";
import type { ContractTransactionResponse, TransactionResponse } from "ethers";
import { FhevmType } from "@fhevm/hardhat-plugin";
import * as fs from "fs";

const POOL = "0x894F6492357277CF36e9973787663AE9F73387BE";
const MAX_ROUNDS = 5;

const f6 = (v: bigint | null): string => (v === null ? "UNREADABLE" : String(Number(v) / 1e6));

async function main(): Promise<void> {
  await fhevm.initializeCLIApi();
  const [s] = await ethers.getSigners();
  const me = await s!.getAddress();
  const pool = await ethers.getContractAt("ConfidentialPrizePool", POOL, s!);

  const dec = async (h: string): Promise<bigint | null> => {
    if (!h || h === ethers.ZeroHash) return 0n;
    try {
      return (await fhevm.userDecryptEuint(FhevmType.euint64, h, POOL, s!)) as bigint;
    } catch {
      return null;
    }
  };
  const read = async (): Promise<{ pos: bigint | null; pend: bigint | null; win: bigint | null }> => ({
    pos: await dec(await pool.confidentialBalanceOf!(me)),
    pend: await dec(await pool.pendingOf!(me)),
    win: await dec(await pool.winningsOf!(me)),
  });

  const hashes: Record<string, string> = {};
  const tx = async (name: string, p: Promise<ContractTransactionResponse>): Promise<void> => {
    const t = await p;
    const r = await t.wait();
    hashes[name] = t.hash;
    console.log(`  ${name.padEnd(14)} ${t.hash}  gas ${r!.gasUsed}`);
  };

  let st = await read();
  console.log(`start: position=${f6(st.pos)} pending=${f6(st.pend)} winnings=${f6(st.win)}`);
  const startWin = st.win;

  const minPeriod = Number(await pool.minPeriod!());
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  for (let i = 1; i <= MAX_ROUNDS; i++) {
    console.log(`\n--- round ${i} ---`);
    // openDraw refuses until minPeriod has passed since the last snapshot, so
    // wait it out rather than burning a revert on TooSoon.
    const prev = await pool.drawAt!(Number(await pool.drawCount!()));
    const earliest = Number(prev.snapshotAt) + minPeriod;
    const nowTs = Math.floor(Date.now() / 1000);
    if (earliest > nowTs) {
      const wait = earliest - nowTs + 15;
      console.log(`  waiting ${wait}s for minPeriod (${minPeriod}s) to elapse`);
      await sleep(wait * 1000);
    }
    try {
      await tx("harvest", pool.harvest!());
    } catch (e) {
      console.log(`  harvest failed: ${String((e as Error).message).split("\n")[0]!.slice(0, 110)}`);
    }
    await tx("openDraw", pool.openDraw!());
    const id = Number(await pool.drawCount!());
    const d = await pool.drawAt!(id);
    const pub = await fhevm.publicDecrypt([d.encR, d.encTotalWeight]);
    await tx("revealDraw", pool.revealDraw!(id, pub.abiEncodedClearValues, pub.decryptionProof));
    const rd = await pool.drawAt!(id);
    await tx("accrue", pool.accrue!(me, id));

    st = await read();
    const threshold = await pool["thresholdFor(uint32,address)"]!(id, me);
    console.log(
      `  draw ${id}: r=${rd.r} totalWeight=${rd.totalWeight} myThreshold(ordinary)=${threshold}`,
    );
    console.log(`  position=${f6(st.pos)} pending=${f6(st.pend)} winnings=${f6(st.win)}`);

    if (st.win !== null && startWin !== null && st.win > startWin) {
      console.log(`  *** WON: winnings ${f6(startWin)} -> ${f6(st.win)} ***`);
      break;
    }
    console.log("  no credit this round");
  }

  console.log("\n--- claim, with the pending credit that is actually there ---");
  const beforePos = st.pos;
  const beforeWin = st.win;
  await tx("claim", pool.claim!(me));
  const after = await read();
  console.log(`  position ${f6(beforePos)} -> ${f6(after.pos)}`);
  console.log(`  winnings ${f6(beforeWin)} -> ${f6(after.win)}`);
  const moved = beforePos !== null && after.pos !== null ? after.pos - beforePos : null;
  console.log(`  claim moved: ${moved === null ? "unknown" : f6(moved)} cUSDC into the balance`);

  fs.mkdirSync("out", { recursive: true });
  fs.writeFileSync(
    "out/d1-claim-proof.json",
    JSON.stringify(
      {
        at: new Date().toISOString(),
        signer: me,
        hashes,
        startWinnings: startWin?.toString() ?? null,
        endWinnings: after.win?.toString() ?? null,
        positionBeforeClaim: beforePos?.toString() ?? null,
        positionAfterClaim: after.pos?.toString() ?? null,
        claimMoved: moved?.toString() ?? null,
      },
      null,
      2,
    ),
  );
  console.log("\nwrote out/d1-claim-proof.json");
}

main().catch((e) => {
  console.error(String(e).split("\n").slice(0, 4).join("\n"));
  process.exitCode = 1;
});

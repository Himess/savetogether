/**
 * A round that actually pays, on a pool that has been earning.
 *
 * `demo-round.ts` harvests immediately after seeding the deposits, which is
 * correct and produces a round nobody wins: no time has passed, so there is no
 * yield, so the reserve is empty and `tryDecrease` pays zero even to a holder
 * who cleared their threshold. That is the paired test's behaviour working —
 * prizes come from harvested yield and from nothing else — and it is a poor
 * first impression.
 *
 * This waits for the draw floor, harvests what has actually accrued in the
 * meantime, and then runs the draw. It also respects `minPeriod`, which is the
 * point of the V2 fix: draws cannot be opened faster than the schedule.
 *
 *   POOL=0x… npx hardhat run scripts/seed-round.ts --network sepolia
 */
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import type { Contract } from "ethers";

const POOL = process.env["POOL"] ?? "";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  if (POOL === "") throw new Error("set POOL");
  await fhevm.initializeCLIApi();
  const [signer] = await ethers.getSigners();

  const pool = (await ethers.getContractAt(
    "ConfidentialPrizePool",
    POOL,
    signer,
  )) as unknown as Contract;

  const minPeriod = Number(await pool.minPeriod!());
  const drawCount = Number(await pool.drawCount!());
  const last = drawCount === 0 ? Number(await pool.genesis!()) : Number((await pool.drawAt!(drawCount)).snapshotAt);
  const openableAt = last + minPeriod;

  const now = (await ethers.provider.getBlock("latest"))!.timestamp;
  const wait = Math.max(0, openableAt - now) + 15;
  if (wait > 0) {
    console.log(`the floor is ${minPeriod}s and the last draw opened at ${last}`);
    console.log(`waiting ${wait}s — this is the V2 fix doing its job`);
    await sleep(wait * 1000);
  }

  // Harvest what actually accrued while we waited. The reserve fills from here
  // and nowhere else, which is the claim the paired test carries.
  console.log("harvesting");
  await (await pool.harvest!()).wait();

  /**
   * Reveal, with the cleartexts and the proof from one call.
   *
   * `revealDraw` rebuilds the handle list in exactly this order, and the plugin
   * returns both halves together — the keeper does the same.
   */
  const reveal = async (drawId: number): Promise<void> => {
    const d = await pool.drawAt!(drawId);
    const pub = await fhevm.publicDecrypt([d.encR, d.encTotalWeight]);
    console.log(`  R           ${pub[d.encR]}`);
    console.log(`  totalWeight ${pub[d.encTotalWeight]}`);
    await (await pool.revealDraw!(drawId, pub.abiEncodedClearValues, pub.decryptionProof)).wait();
    console.log(`draw ${drawId} revealed`);
  };

  // Repair before advancing, the way the keeper does. A draw left Open by an
  // earlier failure blocks every later one with PreviousDrawUnresolved, and
  // discovering that from a bare `execution reverted` is not a good afternoon.
  const current = Number(await pool.drawCount!());
  if (current > 0 && Number((await pool.drawAt!(current)).status) === 1) {
    console.log(`draw ${current} was left open — revealing it first`);
    await reveal(current);
  }

  const id = Number(await pool.drawCount!()) + 1;
  console.log(`opening draw ${id}`);
  await (await pool.openDraw!()).wait();
  await reveal(id);

  // From the deployment block, not from zero: the RPC caps a log query at 50,000
  // blocks and a fresh pool is only a few hundred old, so asking from genesis
  // fails on the provider rather than on anything to do with the pool.
  const deployedAt = (JSON.parse(
    require("fs").readFileSync("out/deployment.json", "utf8"),
  ) as { block: number }).block;
  const events = await pool.queryFilter!(pool.filters!.Deposited!(), deployedAt, "latest");
  const who = [...new Set(events.map((e) => (e as unknown as { args: { user: string } }).args.user))];
  // Chunked, and smaller than the keeper's six. The measured budget is 2,582,192
  // HCU per accrual with a WARM cache and 3,537,224 cold (findings §11.1), and
  // six cold ones is 21.2M against a 20M ceiling — which is a bare
  // `execution reverted` from `estimateGas` with nothing in it to read. Four
  // cold ones is 14.1M and fits with room.
  const CHUNK = 4;
  let total = 0n;
  for (let i = 0; i < who.length; i += CHUNK) {
    const slice = who.slice(i, i + CHUNK);
    const rc = await (await pool.accrueMany!(slice, id)).wait();
    total += rc.gasUsed;
    console.log(`  accrued ${slice.length} (${i + slice.length}/${who.length}), ${rc.gasUsed} gas`);
  }
  console.log(`accrued ${who.length} across ${Math.ceil(who.length / CHUNK)} transactions, ${total} gas`);

  // Thresholds are public — they are a pure function of R, the draw and the
  // address, which is what lets anyone verify their own outcome without a
  // transaction. Winnings are NOT: `accrue` grants that handle to the holder
  // alone, so this script cannot read them and neither can anyone else. An
  // earlier version tried and got told so by the relayer, which is the privacy
  // property working rather than a failure.
  console.log("\nthresholds are public; winnings are readable only by their holder:");
  for (const w of who) {
    const threshold = await pool.thresholdFor!(id, w);
    const h = await pool.winningsOf!(w);
    console.log(
      `  ${w}  threshold ${String(threshold).padStart(12)}  winnings ${h === ethers.ZeroHash ? "none yet" : "encrypted"}`,
    );
  }
  console.log(`\ntotal weight for draw ${id}: ${(await pool.drawAt!(id)).totalWeight}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

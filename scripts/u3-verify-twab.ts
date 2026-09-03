/**
 * U3 — does the browser's reconstruction equal what the chain computes?
 *
 * The "Your position" screen rebuilds a holder's per-draw weight locally, from
 * their decrypted observation record, using a copy of the contract's own formula
 * in `frontend/lib/twab.ts`. That is what lets the history table fill in without a
 * transaction per row — `weightFor` is a state change because it must grant ACL,
 * and a holder who has already decrypted their observations needs no grant to do
 * the same arithmetic themselves.
 *
 * A copy of a formula is a claim, so this checks it: fetch the real observations,
 * decrypt them, reconstruct the weight for a real draw, and compare against the
 * live `weightFor` for the same draw. If the two disagree, every number on that
 * screen is wrong and the screen should not ship.
 *
 *   npx hardhat run scripts/u3-verify-twab.ts --network sepolia
 */
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import * as fs from "fs";

const POOL = "0xa9B69Dc9F9f4C4512c926ba9eA432eBcF0026631";

interface Obs {
  timestamp: number;
  balance: bigint;
  cumulative: bigint;
}

/** `frontend/lib/twab.ts` cumulativeAtLocal, re-stated so a drift shows up here. */
function cumulativeAtLocal(obs: Obs[], target: number): bigint {
  if (obs.length === 0 || obs[0]!.timestamp > target) return 0n;
  let lo = 0;
  let hi = obs.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (obs[mid]!.timestamp <= target) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  const o = obs[found]!;
  return o.cumulative + o.balance * BigInt(target - o.timestamp);
}

async function main(): Promise<void> {
  await fhevm.initializeCLIApi();
  const [s] = await ethers.getSigners();
  const me = await s!.getAddress();
  const pool = await ethers.getContractAt("ConfidentialPrizePool", POOL, s!);

  const n = Number(await pool.observationCount!(me));
  console.log(`holder ${me}`);
  console.log(`observations: ${n}`);
  if (n === 0) {
    console.log("nothing to verify — this address has never deposited");
    return;
  }

  const obs: Obs[] = [];
  for (let i = 0; i < n; i++) {
    const o = await pool.observationAt!(me, i);
    const bal =
      o.balance === ethers.ZeroHash
        ? 0n
        : ((await fhevm.userDecryptEuint(FhevmType.euint64, o.balance, POOL, s!)) as bigint);
    const cum =
      o.cumulative === ethers.ZeroHash
        ? 0n
        : ((await fhevm.userDecryptEuint(FhevmType.euint128, o.cumulative, POOL, s!)) as bigint);
    obs.push({ timestamp: Number(o.timestamp), balance: bal, cumulative: cum });
    console.log(
      `  [${i}] t=${o.timestamp}  balance=${Number(bal) / 1e6}  cumulative=${cum}`,
    );
  }
  obs.sort((a, b) => a.timestamp - b.timestamp);

  const latest = Number(await pool.drawCount!());
  const rows: { draw: number; local: string; chain: string; match: boolean }[] = [];

  for (const id of [latest, latest - 1, latest - 2].filter((x) => x > 0)) {
    const d = await pool.drawAt!(id);
    if (Number(d.status) !== 2) {
      console.log(`\ndraw ${id}: not revealed, skipping`);
      continue;
    }
    // The contract's own window: previous snapshot when that draw was revealed,
    // else this draw's periodStart. Mirror it exactly rather than approximating.
    let from = Number(d.periodStart);
    if (id > 1) {
      const prev = await pool.drawAt!(id - 1);
      if (Number(prev.status) === 2) from = Number(prev.snapshotAt);
    }
    const local = cumulativeAtLocal(obs, Number(d.snapshotAt)) - cumulativeAtLocal(obs, from);

    await (await pool.weightFor!(id, me)).wait();
    const handle = await pool.weightFor!.staticCall(id, me);
    const chain = (await fhevm.userDecryptEuint(FhevmType.euint128, handle, POOL, s!)) as bigint;

    const match = local === chain;
    rows.push({ draw: id, local: local.toString(), chain: chain.toString(), match });
    console.log(
      `\ndraw ${id}: window ${from} -> ${d.snapshotAt}` +
        `\n  reconstructed in the browser : ${local}` +
        `\n  computed by the contract     : ${chain}` +
        `\n  ${match ? "MATCH" : "!! MISMATCH — the screen would be lying"}`,
    );
  }

  const ok = rows.length > 0 && rows.every((r) => r.match);
  console.log(`\n${ok ? "PASS" : "FAIL"} — ${rows.filter((r) => r.match).length}/${rows.length} draws agree`);

  fs.mkdirSync("out", { recursive: true });
  fs.writeFileSync(
    "out/u3-twab-verify.json",
    JSON.stringify({ at: new Date().toISOString(), holder: me, observations: obs.map((o) => ({ ...o, balance: o.balance.toString(), cumulative: o.cumulative.toString() })), rows, ok }, null, 2),
  );
  console.log("wrote out/u3-twab-verify.json");
  if (!ok) process.exitCode = 1;
}

main().catch((e) => {
  console.error(String(e).split("\n").slice(0, 4).join("\n"));
  process.exitCode = 1;
});

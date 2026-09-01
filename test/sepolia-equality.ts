/**
 * The equality run: does `accrue` cost the same whether it awarded a prize or not?
 *
 * This is the measurement the central claim rests on. If a winner's accrual and a
 * loser's differ in observable gas, "only the winner learns the outcome" is false
 * on the cheapest observation available, and nothing downstream repairs it.
 *
 * Method carried from SaveTogether's `docs/leakage.md`:
 *
 *   - Execution gas, not `gasUsed`. Intrinsic calldata cost varies with the
 *     zero-byte count of the address argument, which has nothing to do with the
 *     secret; comparing totals would measure the addresses.
 *   - HCU reconstructed from the coprocessor's per-op events, since it lives in
 *     transient storage with no accessor.
 *   - Arms interleaved, so any drift over the run hits both equally.
 *
 * ARM CONSTRUCTION. Accounts deposit at the same moment, half large and half
 * tiny, and every round is revealed with a FIXED `totalWeight` so the threshold
 * search behaves identically across rounds. A large account's weight sits above
 * every threshold in `[0, total)` and wins each round; a tiny one's sits below
 * almost all of them and loses. Both take the identical code path — each has an
 * observation before the snapshot, so neither hits the zero-weight shortcut — and
 * every arm's outcome is VERIFIED at the end by reading its lifetime winnings.
 *
 * RESUMABLE, because it has to be. A 120-round run takes about 150 minutes and
 * was killed twice mid-flight. State — the pool, the token, the arms' keys — is
 * written to `out/arms-<TAG>.json` on the first invocation and reloaded on every
 * later one, which continues from the chain's own `drawCount`. Samples append to
 * `out/equality-<TAG>.json`. The run is therefore a sequence of short invocations
 * that accumulate rather than one long one that can lose everything.
 *
 * `forceReveal` stands in for the KMS round trip, which was verified end to end
 * in `test/sepolia-reveal.ts`. `accrue` is inherited unchanged and the reveal is a
 * different transaction, so what is measured here is the production function.
 *
 *   TAG=c ARMS=5 ROUNDS=4 npx hardhat test test/sepolia-equality.ts --network sepolia
 */
import { ethers, fhevm } from "hardhat";
import type { Contract, HDNodeWallet } from "ethers";
import { FhevmType } from "@fhevm/hardhat-plugin";
import * as fs from "fs";
import * as path from "path";

const TAG = process.env.TAG ?? "a";
const ROUNDS = Number(process.env.ROUNDS ?? 4);
/**
 * Arms per side. Each draw yields ARMS winner samples and ARMS loser samples, so
 * the draw overhead — openDraw plus the reveal — is amortised rather than paid
 * twice per sample. The threshold is a function of the address, so extra arms are
 * extra independent observations rather than repeats of one.
 */
const ARMS = Number(process.env.ARMS ?? 5);
const PRIZE = 5_000n;
const TOTAL = 1_000_000n;

const HCU: Record<string, { scalar: number; cipher: number }> = {
  FheAdd: { scalar: 133_000, cipher: 162_000 },
  FheSub: { scalar: 133_000, cipher: 162_000 },
  FheMul: { scalar: 365_000, cipher: 596_000 },
  FheGe: { scalar: 116_000, cipher: 152_000 },
  FheGt: { scalar: 117_000, cipher: 152_000 },
  FheIfThenElse: { scalar: 55_000, cipher: 55_000 },
  TrivialEncrypt: { scalar: 32, cipher: 32 },
  Cast: { scalar: 32, cipher: 32 },
};

const ABI = [
  "event FheAdd(address indexed caller, bytes32 lhs, bytes32 rhs, bytes1 scalarByte, bytes32 result)",
  "event FheSub(address indexed caller, bytes32 lhs, bytes32 rhs, bytes1 scalarByte, bytes32 result)",
  "event FheMul(address indexed caller, bytes32 lhs, bytes32 rhs, bytes1 scalarByte, bytes32 result)",
  "event FheGe(address indexed caller, bytes32 lhs, bytes32 rhs, bytes1 scalarByte, bytes32 result)",
  "event FheGt(address indexed caller, bytes32 lhs, bytes32 rhs, bytes1 scalarByte, bytes32 result)",
  "event FheIfThenElse(address indexed caller, bytes32 control, bytes32 ifTrue, bytes32 ifFalse, bytes32 result)",
  "event TrivialEncrypt(address indexed caller, uint256 pt, uint8 toType, bytes32 result)",
  "event Cast(address indexed caller, bytes32 ct, uint8 toType, bytes32 result)",
];
const iface = new ethers.Interface(ABI);

function calldataGas(data: string): number {
  const b = ethers.getBytes(data);
  let z = 0;
  for (const x of b) if (x === 0) z++;
  return z * 4 + (b.length - z) * 16;
}

function analyse(logs: readonly { topics: string[]; data: string }[]) {
  const counts: Record<string, number> = {};
  let hcu = 0;
  for (const log of logs) {
    let p;
    try {
      p = iface.parseLog({ topics: [...log.topics], data: log.data });
    } catch {
      continue;
    }
    if (p === null) continue;
    const c = HCU[p.name];
    if (c === undefined) continue;
    counts[p.name] = (counts[p.name] ?? 0) + 1;
    const sb = p.args["scalarByte"] as string | undefined;
    hcu += sb !== undefined && sb !== "0x00" ? c.scalar : c.cipher;
  }
  return {
    hcu,
    ops: Object.keys(counts)
      .sort()
      .map((k) => `${k}x${counts[k]}`)
      .join(" "),
  };
}

interface Sample {
  arm: "winner" | "loser";
  round: number;
  exec: string;
  hcu: number;
  ops: string;
  tx: string;
}

interface Setup {
  pool: string;
  token: string;
  arms: { name: "winner" | "loser"; pk: string; amount: string }[];
}

const OUT = path.join(__dirname, "..", "out");
const setupFile = path.join(OUT, `arms-${TAG}.json`);
const sampleFile = path.join(OUT, `equality-${TAG}.json`);

describe("accrue: winner against loser", () => {
  it(`adds ${ROUNDS} rounds of ${ARMS} arms per side to batch ${TAG}`, async function () {
    this.timeout(6 * 60 * 60 * 1000);

    await fhevm.initializeCLIApi();
    const [signer] = await ethers.getSigners();
    const me = await signer.getAddress();
    fs.mkdirSync(OUT, { recursive: true });

    let setup: Setup;
    let pool: Contract;
    let token: Contract;

    if (fs.existsSync(setupFile)) {
      setup = JSON.parse(fs.readFileSync(setupFile, "utf8")) as Setup;
      pool = (await ethers.getContractAt(
        "PrizePoolHarness",
        setup.pool,
        signer,
      )) as unknown as Contract;
      token = (await ethers.getContractAt(
        "ERC7984Mock",
        setup.token,
        signer,
      )) as unknown as Contract;
      console.log(`\n    resuming batch ${TAG} on ${setup.pool}, ${setup.arms.length} arms`);
    } else {
      console.log(`\n    starting batch ${TAG}`);
      const Token = await ethers.getContractFactory("ERC7984Mock");
      const t = await Token.deploy("cUSDC", "cUSDC", "");
      await t.waitForDeployment();
      token = t as unknown as Contract;

      const Pool = await ethers.getContractFactory("PrizePoolHarness");
      const p = await Pool.deploy(await t.getAddress(), 0);
      await p.waitForDeployment();
      pool = p as unknown as Contract;
      const addr = await p.getAddress();

      await (await token.mint(me, 1_000_000_000n)).wait();
      await (await pool.setPrize(PRIZE)).wait();
      const now0 = (await ethers.provider.getBlock("latest"))!.timestamp;
      await (await token.setOperator(addr, now0 + 365 * 24 * 3600)).wait();
      const e = await fhevm.createEncryptedInput(addr, me).add64(500_000_000n).encrypt();
      await (await pool.fundReserve(e.handles[0]!, e.inputProof)).wait();

      setup = { pool: addr, token: await t.getAddress(), arms: [] };
      for (let i = 0; i < ARMS; i++) {
        for (const [name, amount] of [
          ["winner", 1_000_000n],
          ["loser", 1n],
        ] as const) {
          setup.arms.push({
            name,
            pk: ethers.Wallet.createRandom().privateKey,
            amount: amount.toString(),
          });
        }
      }
      // Written before the deposits run: if funding dies half way, the next
      // invocation has to know which accounts already exist rather than minting a
      // fresh set and stranding the first.
      fs.writeFileSync(setupFile, JSON.stringify(setup, null, 2));

      for (const a of setup.arms) {
        const w = new ethers.Wallet(a.pk, ethers.provider);
        await (
          await signer.sendTransaction({ to: w.address, value: ethers.parseEther("0.004") })
        ).wait();
        await (await token.mint(w.address, BigInt(a.amount) * 2n)).wait();
        const until = (await ethers.provider.getBlock("latest"))!.timestamp + 365 * 24 * 3600;
        await (await (token.connect(w) as Contract).setOperator(addr, until)).wait();
        const enc = await fhevm
          .createEncryptedInput(addr, w.address)
          .add64(BigInt(a.amount))
          .encrypt();
        await (await (pool.connect(w) as Contract).deposit(enc.handles[0], enc.inputProof)).wait();
      }
      console.log(`    pool ${addr}, ${setup.arms.length} arms funded and deposited`);
    }

    const wallets = setup.arms.map((a) => ({
      name: a.name,
      w: new ethers.Wallet(a.pk, ethers.provider) as unknown as HDNodeWallet,
    }));

    const prior: Sample[] = fs.existsSync(sampleFile)
      ? (JSON.parse(fs.readFileSync(sampleFile, "utf8")).samples as Sample[])
      : [];
    const samples: Sample[] = [...prior];
    // Repair before advancing, for the same reason the keeper does. A run killed
    // between openDraw and forceReveal leaves a draw Open, and openDraw then
    // reverts PreviousDrawUnresolved forever. Resuming has to finish that draw
    // rather than step over it.
    const count = Number(await pool.drawCount());
    let first = count + 1;
    if (count >= 1) {
      const last = await pool.drawAt(count);
      if (Number(last.status) !== 2) {
        console.log(`    draw ${count} was left ${Number(last.status) === 1 ? "Open" : "unset"} — finishing it`);
        first = count;
      }
    }
    console.log(`    ${prior.length} samples on file, continuing from draw ${first}`);

    for (let round = first; round < first + ROUNDS; round++) {
      if (Number((await pool.drawAt(round)).status) === 0) {
        await (await pool.openDraw()).wait();
      }
      // R varies per round; TOTAL is fixed so `_uniform`'s rejection loop cannot
      // become a second variable across rounds.
      if (Number((await pool.drawAt(round)).status) === 1) {
        await (await pool.forceReveal(round, BigInt(round) * 7919n + 13n, TOTAL)).wait();
      }

      const before = samples.length;
      for (const a of wallets) {
        // An already-accrued pair returns early, so re-running it would record
        // the early-return gas as though it were a measurement. Skipping keeps
        // the resume path from quietly poisoning the sample.
        if (await pool.accrued(round, a.w.address)) continue;
        const tx = await pool.accrue(a.w.address, round);
        const receipt = await tx.wait();
        const sent = await ethers.provider.getTransaction(tx.hash);
        const { hcu, ops } = analyse(receipt!.logs as never);
        const exec = receipt!.gasUsed - BigInt(calldataGas(sent!.data));
        samples.push({ arm: a.name, round, exec: exec.toString(), hcu, ops, tx: tx.hash });
      }
      const added = samples.length - before;
      const fresh = samples.slice(-Math.max(added, 1));
      const tail = (n: string) =>
        fresh
          .filter((x) => x.arm === n)
          .map((x) => x.exec.slice(-3))
          .join(" ");
      console.log(
        `    r${String(round).padStart(3)}  winner ${tail("winner")}   loser ${tail("loser")}`,
      );
      fs.writeFileSync(sampleFile, JSON.stringify({ pool: setup.pool, samples }, null, 2));
    }

    // Every arm is checked rather than a representative one: the construction is
    // only as good as its weakest member, and an arm that quietly lost a round
    // would put a loser's sample in the winner column.
    let bad = 0;
    for (const a of wallets) {
      const h = await pool.winningsOf(a.w.address);
      const got =
        h === ethers.ZeroHash
          ? 0n
          : await fhevm.userDecryptEuint(FhevmType.euint64, h, setup.pool, a.w);
      const rounds = BigInt(samples.filter((s) => s.arm === a.name).length) / BigInt(ARMS);
      const want = a.name === "winner" ? rounds * PRIZE : 0n;
      if (got !== want) {
        console.log(`    ARM MISMATCH ${a.name} ${a.w.address}: got ${got}, want ${want}`);
        bad++;
      }
    }
    console.log(`    arms verified: ${wallets.length - bad}/${wallets.length} as constructed`);

    const steady = samples.filter((s) => s.round > 1);
    const per = (arm: string) => {
      const xs = steady.filter((s) => s.arm === arm);
      const counts: Record<string, number> = {};
      for (const x of xs) counts[x.exec] = (counts[x.exec] ?? 0) + 1;
      return {
        n: xs.length,
        counts,
        hcu: [...new Set(xs.map((x) => x.hcu))],
        ops: [...new Set(xs.map((x) => x.ops))].length,
      };
    };
    console.log(`\n    winner ${JSON.stringify(per("winner"))}`);
    console.log(`    loser  ${JSON.stringify(per("loser"))}`);
    fs.writeFileSync(
      sampleFile,
      JSON.stringify({ pool: setup.pool, badArms: bad, samples }, null, 2),
    );
  });
});

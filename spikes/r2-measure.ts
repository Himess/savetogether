/**
 * R2 — what the plaintext-free paths actually cost, measured on live Sepolia.
 *
 * Four ways of moving value into a contract, on one token, with identical
 * bookkeeping, so the spread between them is the mechanism and nothing else.
 * §11.1's lesson is the reason this is measured rather than computed: a figure
 * that lands near the truth because two errors cancel supports nothing.
 *
 * Correctness is checked alongside cost. A path that is cheaper but moves the
 * wrong amount is not cheaper, and `_update` clamps rather than reverting, so a
 * wrong amount arrives quietly.
 *
 *   npx hardhat run spikes/r2-measure.ts --network sepolia
 */
import { FhevmType } from "@fhevm/hardhat-plugin";
import { ethers, fhevm } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const TOKEN = "0x1bbBE55d24174d57305632E75fE47ac3C5158a9F"; // gUSDC, whole units
const ACL = "0xf0Ffdc93b7E186bC2f8CB3dAA75D86d1930A433D";
const EXECUTOR = "0x92C920834Ec8941d2C77D188936E1f7A6f49c127";

const TOKEN_ABI = [
  "function mint(address to, uint64 amount) returns (bytes32)",
  "function confidentialBalanceOf(address) view returns (bytes32)",
  "function isOperator(address,address) view returns (bool)",
  "function setOperator(address,uint48)",
  "function confidentialTransferAndCall(address to, bytes32 amount, bytes data) returns (bytes32)",
];
const ACL_ABI = [
  "function allow(bytes32 handle, address account)",
  "function isAllowed(bytes32 handle, address account) view returns (bool)",
];

interface Row {
  path: string;
  what: string;
  txs: number;
  gas: bigint;
  fheOps: number;
  credited: string;
  hashes: string[];
  expected: string;
  ok: boolean;
}

async function main(): Promise<void> {
  await fhevm.initializeCLIApi();
  const [signer] = await ethers.getSigners();
  const me = await signer.getAddress();
  console.log(`signer ${me}\n`);

  const token = new ethers.Contract(TOKEN, TOKEN_ABI, signer);
  const acl = new ethers.Contract(ACL, ACL_ABI, signer);

  const Spike = await ethers.getContractFactory("PlaintextFreeSpike");
  const spike = await Spike.deploy(TOKEN);
  await spike.waitForDeployment();
  const spikeAddr = await spike.getAddress();
  console.log(`spike  ${spikeAddr}\n`);

  await (await token.setOperator!(spikeAddr, Math.floor(Date.now() / 1000) + 86_400)).wait();

  // Every FHE operation the coprocessor performs is one log from the executor.
  // Counting them is a measurement; attributing HCU to each is read off the code.
  const countFheOps = (rc: { logs: readonly { address: string }[] }): number =>
    rc.logs.filter((l) => l.address.toLowerCase() === EXECUTOR.toLowerCase()).length;

  const credited = async (): Promise<bigint> => {
    const h: string = await spike.creditedOf!(me);
    if (h === ethers.ZeroHash) return 0n;
    return await fhevm.userDecryptEuint(FhevmType.euint64, h, spikeAddr, signer);
  };

  const balance = async (): Promise<bigint> => {
    const h: string = await token.confidentialBalanceOf!(me);
    if (h === ethers.ZeroHash) return 0n;
    return await fhevm.userDecryptEuint(FhevmType.euint64, h, TOKEN, signer);
  };

  const rows: Row[] = [];

  // ------------------------------------------------------------------ A ---
  {
    console.log("A  depositExternal — the path in production today");
    await (await token.mint!(me, 1000n)).wait();
    const before = await credited();

    const enc = await fhevm.createEncryptedInput(spikeAddr, me).add64(100n).encrypt();
    const tx = await spike.depositExternal!(enc.handles[0], enc.inputProof);
    const rc = await tx.wait();

    const after = await credited();
    rows.push({
      path: "A",
      what: "depositExternal(externalEuint64, proof)",
      txs: 1,
      gas: rc.gasUsed,
      fheOps: countFheOps(rc),
      credited: (after - before).toString(),
      hashes: [tx.hash],
      expected: "100",
      ok: after - before === 100n,
    });
    console.log(`   gas ${rc.gasUsed}  fheOps ${countFheOps(rc)}  moved ${after - before}\n`);
  }

  // ------------------------------------------------------------------ B ---
  {
    console.log("B  transferAndCall with the holder's own balance handle — deposit ALL");
    const before = await credited();
    const bal = await balance();
    const handle: string = await token.confidentialBalanceOf!(me);

    // No encryption, no input proof, no ACL grant: the holder is already
    // allowed on their own balance by ERC7984's `_update`.
    const tx = await token.confidentialTransferAndCall!(spikeAddr, handle, "0x");
    const rc = await tx.wait();

    const after = await credited();
    rows.push({
      path: "B",
      what: "token.confidentialTransferAndCall(spike, balanceHandle)",
      txs: 1,
      gas: rc.gasUsed,
      fheOps: countFheOps(rc),
      credited: (after - before).toString(),
      hashes: [tx.hash],
      expected: bal.toString(),
      ok: after - before === bal,
    });
    console.log(
      `   gas ${rc.gasUsed}  fheOps ${countFheOps(rc)}  moved ${after - before} of ${bal}\n`,
    );
  }

  // ------------------------------------------------------------------ C ---
  {
    console.log("C  depositShifted(handle, 1) — half, by shift; needs an ACL grant first");
    await (await token.mint!(me, 800n)).wait();
    const before = await credited();
    const bal = await balance();
    const handle: string = await token.confidentialBalanceOf!(me);

    let gas = 0n;
    let ops = 0;
    if (!(await acl.isAllowed!(handle, spikeAddr))) {
      const g = await (await acl.allow!(handle, spikeAddr)).wait();
      gas += g.gasUsed;
      ops += countFheOps(g);
      console.log(`   ACL.allow  gas ${g.gasUsed}`);
    }

    const tx = await spike.depositShifted!(handle, 1);
    const rc = await tx.wait();
    gas += rc.gasUsed;
    ops += countFheOps(rc);

    const after = await credited();
    rows.push({
      path: "C",
      what: "ACL.allow + depositShifted(handle, 1)",
      txs: 2,
      gas,
      fheOps: ops,
      credited: (after - before).toString(),
      hashes: [tx.hash],
      expected: (bal / 2n).toString(),
      ok: after - before === bal / 2n,
    });
    console.log(
      `   deposit gas ${rc.gasUsed}  total ${gas}  moved ${after - before}, half of ${bal} is ${bal / 2n}\n`,
    );
  }

  // ------------------------------------------------------------------ D ---
  {
    console.log("D  depositDivided(handle, 3) — a third, by scalar division");
    await (await token.mint!(me, 900n)).wait();
    const before = await credited();
    const bal = await balance();
    const handle: string = await token.confidentialBalanceOf!(me);

    let gas = 0n;
    let ops = 0;
    if (!(await acl.isAllowed!(handle, spikeAddr))) {
      const g = await (await acl.allow!(handle, spikeAddr)).wait();
      gas += g.gasUsed;
      ops += countFheOps(g);
      console.log(`   ACL.allow  gas ${g.gasUsed}`);
    }

    const tx = await spike.depositDivided!(handle, 3n);
    const rc = await tx.wait();
    gas += rc.gasUsed;
    ops += countFheOps(rc);

    const after = await credited();
    rows.push({
      path: "D",
      what: "ACL.allow + depositDivided(handle, 3)",
      txs: 2,
      gas,
      fheOps: ops,
      credited: (after - before).toString(),
      hashes: [tx.hash],
      expected: (bal / 3n).toString(),
      ok: after - before === bal / 3n,
    });
    console.log(
      `   deposit gas ${rc.gasUsed}  total ${gas}  moved ${after - before}, a third of ${bal} is ${bal / 3n}\n`,
    );
  }

  console.log("path  txs        gas   fheOps   moved  expected  ok   what");
  for (const r of rows) {
    console.log(
      `${r.path.padEnd(5)} ${String(r.txs).padEnd(4)} ${String(r.gas).padStart(9)} ` +
        `${String(r.fheOps).padStart(7)} ${r.credited.padStart(7)} ${r.expected.padStart(9)}  ` +
        `${r.ok ? "yes" : "NO "}  ${r.what}`,
    );
  }

  const dir = path.join(__dirname, "out");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "r2-plaintext-free.json"),
    JSON.stringify(
      {
        network: "sepolia",
        token: TOKEN,
        spike: spikeAddr,
        block: await ethers.provider.getBlockNumber(),
        rows: rows.map((r) => ({ ...r, gas: r.gas.toString() })),
      },
      null,
      2,
    ),
  );
  console.log(`\nwritten to spikes/out/r2-plaintext-free.json`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

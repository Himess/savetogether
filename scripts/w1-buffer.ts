/**
 * W1 on the live pool: is the withdrawal buffer comfortable, and by how much?
 *
 * The probe is safe by construction. ERC-7984's transfer is all-or-nothing, and
 * `withdraw` refunds anything the source declines to move in the same
 * transaction — `test/withdraw-buffer.ts` pins both. So asking for more than the
 * buffer holds costs a transaction and moves nothing; it cannot strand principal.
 * That makes "ask for everything and see" a measurement rather than a risk.
 *
 *   npx hardhat run scripts/w1-buffer.ts --network sepolia
 *
 * STOP THE KEEPER FIRST — it signs with the same key.
 */
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";

const POOL = "0x1d8A0d653027833E4e8eA4DE67B90512Aad7B85f";
const TOKEN = "0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639";
const U = 1_000_000n;

const fmt = (v: bigint): string => `${Number(v) / 1e6} cUSDC`;

async function main(): Promise<void> {
  await fhevm.initializeCLIApi();
  const [s] = await ethers.getSigners();
  const me = await s!.getAddress();
  const pool = await ethers.getContractAt("ConfidentialPrizePool", POOL, s!);
  const token = new ethers.Contract(
    TOKEN,
    ["function confidentialBalanceOf(address) view returns (bytes32)"],
    s!,
  );

  const read = async (h: string, c: string): Promise<bigint> =>
    h === ethers.ZeroHash ? 0n : ((await fhevm.userDecryptEuint(FhevmType.euint64, h, c, s!)) as bigint);

  const position = async (): Promise<bigint> => read(await pool.confidentialBalanceOf!(me), POOL);
  const walletOf = async (): Promise<bigint> => read(await token.confidentialBalanceOf!(me), TOKEN);

  const pos0 = await position();
  const wal0 = await walletOf();
  console.log(`position ${fmt(pos0)}`);
  console.log(`wallet   ${fmt(wal0)}\n`);

  // ---- 1. round trip on a small amount, asserted on the DELTA ----
  console.log("1. round trip: deposit 50, withdraw 50");
  const R = 50n * U;
  let enc = await fhevm.createEncryptedInput(POOL, me).add64(R).encrypt();
  await (await pool.deposit!(enc.handles[0], enc.inputProof)).wait();
  const posD = await position();
  console.log(`   after deposit  delta ${fmt(posD - pos0)}`);

  enc = await fhevm.createEncryptedInput(POOL, me).add64(R).encrypt();
  await (await pool.withdraw!(enc.handles[0], enc.inputProof)).wait();
  const posW = await position();
  console.log(`   after withdraw delta ${fmt(posW - pos0)}  ${posW === pos0 ? "EXACT" : "NOT EXACT — investigate"}`);

  // ---- 2. how much can actually come out? ----
  // Doubling until it fails would cost a transaction per step; the question that
  // matters is whether the WHOLE position clears, because anything a judge does
  // is far smaller than that.
  console.log(`\n2. can the entire position come out at once? asking for ${fmt(posW)}`);
  const walB = await walletOf();
  enc = await fhevm.createEncryptedInput(POOL, me).add64(posW).encrypt();
  const tx = await pool.withdraw!(enc.handles[0], enc.inputProof);
  await tx.wait();
  const walA = await walletOf();
  const posA = await position();
  const paid = walA - walB;
  console.log(`   paid out    ${fmt(paid)}`);
  console.log(`   position    ${fmt(posA)}`);
  console.log(
    paid === posW
      ? `   BUFFER COVERS THE WHOLE POSITION — at least ${fmt(posW)} is liquid`
      : `   short: the buffer is under ${fmt(posW)}, and nothing moved (position intact: ${posA === posW})`,
  );

  // ---- 3. put it back, so the prize economics survive the measurement ----
  if (paid > 0n) {
    console.log(`\n3. redepositing ${fmt(paid)} so the pool keeps its principal`);
    enc = await fhevm.createEncryptedInput(POOL, me).add64(paid).encrypt();
    await (await pool.deposit!(enc.handles[0], enc.inputProof)).wait();
    const posF = await position();
    console.log(`   position now ${fmt(posF)}  ${posF === posW ? "RESTORED" : "MISMATCH — investigate"}`);
  }
}

main().catch((e) => {
  console.error(String(e).split("\n").slice(0, 4).join("\n"));
  process.exitCode = 1;
});

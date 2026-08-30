/**
 * R4 — what each path discloses, read off the chain rather than argued.
 *
 * The claim to test is not "an observer might guess the ratio". It is stronger
 * and worse: for the plaintext-free paths the ratio is PROVABLE from public data
 * alone, because the calldata names the very handle a public view function
 * returns. An observer does not infer that someone deposited everything; they
 * check it.
 *
 *   npx hardhat run spikes/r4-leak.ts --network sepolia
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const TOKEN = "0x1bbBE55d24174d57305632E75fE47ac3C5158a9F";

async function main(): Promise<void> {
  const measured = JSON.parse(
    fs.readFileSync(path.join(__dirname, "out", "r2-plaintext-free.json"), "utf8"),
  ) as { rows: { path: string; what: string; hashes: string[] }[] };

  const provider = ethers.provider;
  const token = new ethers.Contract(
    TOKEN,
    ["function confidentialBalanceOf(address) view returns (bytes32)"],
    provider,
  );

  const findings: Record<string, unknown>[] = [];

  for (const row of measured.rows) {
    const hash = row.hashes[0]!;
    const tx = await provider.getTransaction(hash);
    if (tx === null) continue;
    const calldata = tx.data;

    // The holder's balance handle as of the block BEFORE this transaction: what
    // any observer could have read for themselves at the time.
    const priorBalanceHandle: string = await token.confidentialBalanceOf!(tx.from, {
      blockTag: tx.blockNumber! - 1,
    });

    const containsPriorBalance = calldata
      .toLowerCase()
      .includes(priorBalanceHandle.slice(2).toLowerCase());

    findings.push({
      path: row.path,
      what: row.what,
      calldataBytes: (calldata.length - 2) / 2,
      priorBalanceHandle,
      calldataNamesTheBalanceHandle: containsPriorBalance,
    });

    console.log(`${row.path}  ${row.what}`);
    console.log(`   calldata            ${(calldata.length - 2) / 2} bytes`);
    console.log(`   holder's balance    ${priorBalanceHandle}`);
    console.log(
      `   calldata names it   ${containsPriorBalance ? "YES — the ratio is provable" : "no"}`,
    );
    if (containsPriorBalance) {
      // The remaining arguments are plaintext, so whatever fraction was taken is
      // in the clear too.
      const tail = calldata.slice(10 + 64);
      console.log(`   remaining args      ${tail === "" ? "(none — the whole balance)" : "0x" + tail}`);
    }
    console.log("");
  }

  fs.writeFileSync(
    path.join(__dirname, "out", "r4-leak.json"),
    JSON.stringify(findings, null, 2),
  );
  console.log("written to spikes/out/r4-leak.json");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

/**
 * Why did path B revert? Get the reason rather than guessing at it.
 *
 *   npx hardhat run spikes/r2-diagnose-b.ts --network sepolia
 */
import { ethers, fhevm } from "hardhat";

const TOKEN = "0x1bbBE55d24174d57305632E75fE47ac3C5158a9F";
const ACL = "0xf0Ffdc93b7E186bC2f8CB3dAA75D86d1930A433D";
const SPIKE = "0x29a1667C1b19b4cD9D2DCd032Ec4EC86439385e2";

async function main(): Promise<void> {
  await fhevm.initializeCLIApi();
  const [signer] = await ethers.getSigners();
  const me = await signer.getAddress();

  const token = new ethers.Contract(
    TOKEN,
    [
      "function confidentialBalanceOf(address) view returns (bytes32)",
      "function isOperator(address,address) view returns (bool)",
      "function confidentialTransferAndCall(address to, bytes32 amount, bytes data) returns (bytes32)",
      "function confidentialTransfer(address to, bytes32 amount) returns (bytes32)",
    ],
    signer,
  );
  const acl = new ethers.Contract(
    ACL,
    ["function isAllowed(bytes32,address) view returns (bool)"],
    signer,
  );

  const handle: string = await token.confidentialBalanceOf!(me);
  console.log(`balance handle       ${handle}`);
  console.log(`isAllowed(h, me)     ${await acl.isAllowed!(handle, me)}`);
  console.log(`isAllowed(h, spike)  ${await acl.isAllowed!(handle, SPIKE)}`);
  console.log(`isAllowed(h, token)  ${await acl.isAllowed!(handle, TOKEN)}`);
  console.log(`spike is operator    ${await token.isOperator!(me, SPIKE)}`);

  // The precondition ERC7984 checks is on msg.sender, and this is a plain
  // transfer rather than a transferFrom, so the operator relationship is not
  // what matters here.
  for (const [label, data] of [
    [
      "confidentialTransferAndCall(spike, h, 0x)",
      token.interface.encodeFunctionData("confidentialTransferAndCall", [SPIKE, handle, "0x"]),
    ],
    [
      "confidentialTransfer(spike, h)",
      token.interface.encodeFunctionData("confidentialTransfer", [SPIKE, handle]),
    ],
  ] as const) {
    try {
      await ethers.provider.call({ from: me, to: TOKEN, data });
      console.log(`\n${label}\n   OK (would succeed)`);
    } catch (e: unknown) {
      const err = e as { data?: string; shortMessage?: string; message?: string };
      console.log(`\n${label}`);
      console.log(`   revert data ${err.data ?? "(none)"}`);
      console.log(`   message     ${err.shortMessage ?? err.message ?? ""}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

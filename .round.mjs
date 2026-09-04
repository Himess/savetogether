import { ethers } from "ethers";
import fs from "fs";
const abi = JSON.parse(fs.readFileSync("artifacts/contracts/ConfidentialPrizePool.sol/ConfidentialPrizePool.json", "utf8")).abi;
const s = JSON.parse(fs.readFileSync("probe/secrets.json", "utf8"));
const p = new ethers.JsonRpcProvider(s.sepoliaRpcUrl || "https://ethereum-sepolia-rpc.publicnode.com");
const w = new ethers.Wallet(s.privateKey, p);
const POOL = "0x894F6492357277CF36e9973787663AE9F73387BE";
const c = new ethers.Contract(POOL, abi, w);
const log = (...a) => console.log(...a);

log("pool     ", POOL);
log("drawCount", String(await c.drawCount()));
log("minPeriod", String(await c.minPeriod()));

log("\n-- harvest --");
let t = await (await c.harvest()).wait();
log("   ", t.hash, t.gasUsed + " gas");

log("\n-- openDraw --");
t = await (await c.openDraw()).wait();
log("   ", t.hash, t.gasUsed + " gas");
const id = Number(await c.drawCount());
log("    draw", id);

const d = await c.drawAt(id);
log("    periodStart", String(d.periodStart), " snapshotAt", String(d.snapshotAt), " status", String(d.status));
const solvent = await c.solventAt(id);
log("    solventAt handle:", solvent);
fs.writeFileSync("out/cd-round.json", JSON.stringify({ pool: POOL, draw: id, solventHandle: solvent, openTx: t.hash }, null, 2));

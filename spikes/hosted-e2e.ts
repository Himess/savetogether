/**
 * The hosted flow, end to end, against a real server and a real chain.
 *
 * This is the report the brief asks for: a session opened from a browser-shaped
 * client with one authorisation, a deposit made through MCP with no terminal in
 * the loop, and the revoke path killing it — with hashes for all three.
 *
 * The "browser" here is a wallet in this process. That is the honest simulation:
 * what makes it a browser flow is that the SERVER never sees the key and every
 * owner action is calldata the wallet signs, and both of those are true here.
 *
 *   npx hardhat run spikes/hosted-e2e.ts --network sepolia
 */
import { ethers } from "hardhat";
import { HostedServer } from "@savetogether/hosted";
import * as fs from "fs";
import * as path from "path";

const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}`;

// No fallback on purpose: a hardcoded provider URL is a credential, and this
// file is in a public repository.
const RPC = process.env["SEPOLIA_RPC_URL"] ?? "";
if (RPC === "") throw new Error("set SEPOLIA_RPC_URL");
const MODULE = "0xE5c667c0C58242f89ee59f9269111A3EfB836Cf6";
const TOKEN = "0x1bbBE55d24174d57305632E75fE47ac3C5158a9F";
const POOL = "0x3f6F8e5A853bEC8FA008b31E28f9B0fD9dC0F287";

const out: Record<string, unknown> = {};

async function post(route: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(`${route} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}

/** One MCP call over streamable HTTP, the way a chat client makes it. */
let mcpId = 0;
async function mcp(url: string, method: string, params: unknown): Promise<unknown> {
  const send = (): Promise<Response> =>
    fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        // Node's fetch pools connections, so the first call after a server
        // restart is made on a socket the old process owned and comes back as
        // ECONNRESET. A real client retries; so does this, once.
        connection: "close",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++mcpId, method, params }),
    });

  let res: Response;
  try {
    res = await send();
  } catch {
    await new Promise((r) => setTimeout(r, 1000));
    res = await send();
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`mcp ${method} -> ${res.status} ${text}`);
  // enableJsonResponse gives plain JSON; be tolerant of an SSE frame anyway.
  const payload = text.startsWith("event:") || text.startsWith("data:")
    ? text.split("\n").find((l) => l.startsWith("data:"))!.slice(5).trim()
    : text;
  const body = JSON.parse(payload) as { result?: unknown; error?: { message: string } };
  if (body.error !== undefined) throw new Error(`mcp ${method}: ${body.error.message}`);
  return body.result;
}

async function main(): Promise<void> {
  const [owner] = await ethers.getSigners();
  const ownerAddress = await owner!.getAddress();
  console.log(`owner (the browser wallet)  ${ownerAddress}\n`);

  process.env["SAVETOGETHER_MASTER_KEY"] ??= require("crypto").randomBytes(32).toString("hex");

  const makeServer = (): HostedServer =>
    new HostedServer({
      rpcUrl: RPC,
      chainId: 11155111,
      port: PORT,
      publicUrl: BASE,
      moduleAddress: MODULE,
      aclAddress: "0xf0Ffdc93b7E186bC2f8CB3dAA75D86d1930A433D",
      pool: { address: POOL, token: "gUSDC" },
      tokens: [
        { symbol: "gUSDC", address: TOKEN, decimals: 0 },
        {
          // `underlying` is what makes wrap possible at all — without the link
          // the tool refuses with "not a wrapper" on a contract that plainly is.
          symbol: "cUSDC",
          address: "0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639",
          decimals: 6,
          underlying: "0x9b5Cd13b8eFbB58Dc25A05CF411D8056058aDFfF",
        },
      ],
      vault: {
        adapter: "0xc5120E26aafdD76D324E62cF19c391C367Cf99Ba",
        batcher: "0x48758559c14d4d92b4C74A99660B6a8dbe85F53b",
      },
      allowedOrigins: ["http://localhost:3000"],
    });

  let server = makeServer();
  await server.start();
  console.log("server up, holding nothing\n");

  try {
    // Make sure the owner has something to deposit.
    const token = new ethers.Contract(
      TOKEN,
      ["function mint(address to, uint64 amount) returns (bytes32)"],
      owner!,
    );
    await (await token.mint!(ownerAddress, 2_000n)).wait();

    // --------------------------------------------------------------- open --
    console.log("1-2. browser asks; server generates the key and signs the digest");
    const prepared = (await post("/api/session/prepare", {
      ownerAddress,
      budgets: [{ token: "gUSDC", amount: "800" }],
      recipients: [],
      ttlHours: 24,
      readScope: "balance-visible",
    })) as {
      sessionToken: string;
      sessionKeyAddress: string;
      calls: { to: string; data: string; value?: string }[];
      summary: unknown;
    };
    console.log(`   session key  ${prepared.sessionKeyAddress}`);
    console.log(`   ${prepared.calls.length} calls for the wallet to sign`);

    console.log(`\n3-4. the wallet signs them`);
    const openHashes: string[] = [];
    for (const c of prepared.calls) {
      const tx = await owner!.sendTransaction({
        to: c.to,
        data: c.data,
        ...(c.value === undefined ? {} : { value: BigInt(c.value) }),
      });
      await tx.wait();
      openHashes.push(tx.hash);
      console.log(`   ${tx.hash}`);
    }

    console.log(`\n5-6. server checks the chain before it serves anything`);
    const adopted = (await post("/api/session/adopt", {
      sessionToken: prepared.sessionToken,
    })) as { mcpUrl: string };
    console.log(`   ${adopted.mcpUrl}`);

    // A session nobody opened must not be adoptable.
    let forgedRejected = false;
    try {
      await post("/api/session/adopt", { sessionToken: "made-up-token" });
    } catch {
      forgedRejected = true;
    }
    console.log(`   a made-up claim is rejected: ${forgedRejected ? "yes" : "NO — BUG"}`);

    // ---------------------------------------------------------------- MCP --
    console.log(`\n7. a chat client talks to it`);
    await mcp(adopted.mcpUrl, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "hosted-e2e", version: "0" },
    });
    const listed = (await mcp(adopted.mcpUrl, "tools/list", {})) as {
      tools: { name: string }[];
    };
    const names = listed.tools.map((t) => t.name).sort();
    console.log(`   ${names.length} tools: ${names.join(", ")}`);
    // wrap is no longer withheld: it wraps for the account this session acts as,
    // which hosted is the session key holding its own position.
    for (const withheld of ["open_session", "add_recipient"]) {
      if (names.includes(withheld)) throw new Error(`${withheld} should not be hosted`);
    }
    console.log(`   the wallet-needing tools are absent, as intended`);
    for (const wanted of ["wrap", "vault_status", "vault_join"]) {
      if (!names.includes(wanted)) throw new Error(`${wanted} should be hosted`);
    }
    console.log(`   wrap and the vault tools are present`);

    const status = (await mcp(adopted.mcpUrl, "tools/call", {
      name: "pool_status",
      arguments: {},
    })) as { content: { text: string }[] };
    console.log(`   pool_status -> ${status.content[0]!.text.slice(0, 90)}`);

    // The two tools that complete the chain, exercised rather than assumed.
    // vault_status is a read; wrap mints the test underlying to the session key
    // and wraps it, which is the "make this cUSDC" step and had never run hosted.
    console.log(`\n7b. the composition tools`);
    const vs = (await mcp(adopted.mcpUrl, "tools/call", {
      name: "vault_status",
      arguments: {},
    })) as { content: { text: string }[]; isError?: boolean };
    console.log(`   vault_status -> ${vs.content[0]!.text.slice(0, 160)}`);
    if (vs.isError === true) throw new Error("vault_status failed");

    const wrapped = (await mcp(adopted.mcpUrl, "tools/call", {
      name: "wrap",
      arguments: { token: "cUSDC", amount: "5" },
    })) as { content: { text: string }[]; isError?: boolean };
    console.log(`   wrap -> ${wrapped.content[0]!.text.slice(0, 200)}`);
    if (wrapped.isError === true) {
      throw new Error(`wrap failed: ${wrapped.content[0]!.text}`);
    }

    console.log(`\n8. the deposit, made from the conversation`);
    const deposit = (await mcp(adopted.mcpUrl, "tools/call", {
      name: "pool_deposit",
      arguments: { amount: "200" },
    })) as { content: { text: string }[]; isError?: boolean };
    console.log(`   pool_deposit -> ${deposit.content[0]!.text}`);
    if (deposit.isError === true) throw new Error("the deposit failed");

    const position = (await mcp(adopted.mcpUrl, "tools/call", {
      name: "pool_position",
      arguments: { reveal: false },
    })) as { content: { text: string }[] };
    console.log(`   pool_position -> ${position.content[0]!.text.slice(0, 110)}`);

    // ------------------------------------------------------------ restart --
    console.log(`
8b. RESTART the server — the URL must survive it`);
    await server.stop();
    server = makeServer();
    await server.start();
    console.log(`   restarted, holding nothing from before`);
    const afterRestart = (await mcp(adopted.mcpUrl, "tools/call", {
      name: "pool_status",
      arguments: {},
    })) as { content: { text: string }[] };
    console.log(`   same URL still works -> ${afterRestart.content[0]!.text.slice(0, 70)}`);

    // ------------------------------------------------------------- revoke --
    console.log(`\n9. the user kills it from their own wallet`);
    const info = (await (
      await fetch(`${BASE}/api/session/${prepared.sessionToken}`)
    ).json()) as { live: boolean; revoke: { what: string; to: string; data: string }[] };
    console.log(`   live before: ${info.live}`);
    const revokeHashes: string[] = [];
    for (const r of info.revoke) {
      const tx = await owner!.sendTransaction({ to: r.to, data: r.data });
      await tx.wait();
      revokeHashes.push(tx.hash);
      console.log(`   ${tx.hash}  ${r.what}`);
    }

    const after = (await (
      await fetch(`${BASE}/api/session/${prepared.sessionToken}`)
    ).json()) as { live: boolean };
    console.log(`   live after:  ${after.live}`);

    // And the endpoint must stop working.
    let deadEndpointRejected = false;
    try {
      const dead = (await mcp(adopted.mcpUrl, "tools/call", {
        name: "pool_deposit",
        arguments: { amount: "1" },
      })) as { isError?: boolean };
      deadEndpointRejected = dead.isError === true;
    } catch {
      deadEndpointRejected = true;
    }
    console.log(`   the URL can still spend: ${deadEndpointRejected ? "no" : "YES — BUG"}`);

    Object.assign(out, {
      ownerAddress,
      sessionKeyAddress: prepared.sessionKeyAddress,
      mcpUrl: adopted.mcpUrl,
      openHashes,
      depositText: deposit.content[0]!.text,
      revokeHashes,
      liveBefore: info.live,
      liveAfter: after.live,
      forgedRejected,
      deadEndpointRejected,
      hostedTools: names,
      survivedRestart: true,
    });
    fs.mkdirSync(path.join(__dirname, "out"), { recursive: true });
    fs.writeFileSync(path.join(__dirname, "out", "hosted-e2e.json"), JSON.stringify(out, null, 2));
    console.log(`\nwritten to spikes/out/hosted-e2e.json`);
  } finally {
    await server.stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

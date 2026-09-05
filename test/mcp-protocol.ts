/**
 * The MCP wire protocol, exercised by a real client.
 *
 * Everything in `test/mcp.ts` inspects `toolDefinitions` and the console directly.
 * Nothing until now connected an actual MCP client and spoke the protocol, which
 * means nothing verified that the server answers `tools/list` and `tools/call` at
 * all — a failure that would only surface in front of a chat client, which is the
 * worst place to find it.
 *
 * This is not a substitute for driving the server with a language model. A client
 * calling a tool by name proves the transport works; it proves nothing about
 * whether a model reading these descriptions picks the right tool. That is Task E
 * and it needs a human at the console.
 *
 *   pnpm test:protocol
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, type SaveTogetherConfig } from "@savetogether/mcp-server";
import { expect } from "chai";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const ZERO = "0x0000000000000000000000000000000000000001";

const EXPECTED_TOOLS = [
  "add_recipient",
  "balance",
  "can_afford",
  "list_assets",
  "open_session",
  "pool_deposit",
  "pool_position",
  "pool_status",
  "pool_withdraw",
  "remaining",
  "revoke_all",
  "send",
  "session_status",
  "unwrap",
  "vault_join",
  "vault_status",
  "wrap",
];

describe("MCP protocol", function () {
  this.timeout(120_000);

  let client: Client;
  let stop: () => Promise<void>;
  let vaultDir: string;

  before(async () => {
    vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "savetogether-proto-"));

    // A config that never needs the network: no tool exercised here reaches the
    // chain. `createServer` does create a vault key, hence the temp directory.
    const config: SaveTogetherConfig = {
      chainId: 11155111,
      rpcUrl: process.env["SEPOLIA_RPC_URL"] ?? "http://127.0.0.1:1",
      moduleAddress: "0xE5c667c0C58242f89ee59f9269111A3EfB836Cf6",
      tokens: [
        { symbol: "gkUSD", address: "0xCFf87b42b916f7aA0F61CD060C9f48772F303D37", decimals: 6 },
      ],
      vaultDir,
    };

    const handles = await createServer(config);
    stop = handles.stop;

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "savetogether-protocol-test", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), handles.server.connect(serverTransport)]);
  });

  after(async () => {
    await client.close();
    await stop();
    await fs.rm(vaultDir, { recursive: true, force: true });
  });

  it("answers tools/list with every tool", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).to.deep.equal(EXPECTED_TOOLS);
    expect(names).to.include("unwrap");
  });

  /**
   * E2. Discovery, which is a different failure from the transport working.
   *
   * A live hosted session could not complete `pool_deposit` with `bal_1:half` —
   * the flagship flow — because tool search never returned `balance`. Every test
   * above passed throughout: `tools/list` answered, the schema was valid, the
   * transport was fine. The defect was in the DESCRIPTION, which is the only
   * field a client's index sees; the `title` is not shipped to it.
   *
   * The cause was sharper than "the two are similar". `balance`'s description
   * never contained the word BALANCE, and `remaining`'s never contained BUDGET.
   * Both opened "Returns an opaque reference by default" and named no subject at
   * all, so an index had nothing to separate them with and every phrasing a user
   * would actually type matched neither. Reproduced in a real client before the
   * fix: "how much do I have" returned no SaveTogether tool.
   *
   * These assertions are a proxy for a semantic index and say so. They cannot
   * prove ranking — only a fresh client can, because a connected one caches the
   * list. What they do prove is that the two descriptions name their own
   * subjects and stop overlapping, which is the property that was missing.
   */
  describe("discovery — the descriptions name their own subject", () => {
    const desc = async (name: string): Promise<string> => {
      const { tools } = await client.listTools();
      const t = tools.find((x) => x.name === name);
      expect(t, name).to.not.equal(undefined);
      return (t!.description ?? "").toLowerCase();
    };

    it("balance says it is the holder's balance, in the words a user would use", async () => {
      const d = await desc("balance");
      for (const w of ["balance", "holds", "wallet", "how much do i have"]) {
        expect(d, `balance description is missing "${w}"`).to.include(w);
      }
    });

    it("remaining says it is the session budget, and disclaims being a balance", async () => {
      const d = await desc("remaining");
      for (const w of ["budget", "session", "spend"]) {
        expect(d, `remaining description is missing "${w}"`).to.include(w);
      }
      // The disclaimer is the half that stops the collision: without it the word
      // "balance" appears in both and the index is back where it started.
      expect(d).to.include("not an account balance");
    });

    it("each points at the other, so a wrong pick is recoverable", async () => {
      expect(await desc("balance")).to.include("remaining");
      expect(await desc("remaining")).to.include("balance");
    });

    it("the four phrasings a user types favour balance over remaining", async () => {
      // A crude term-overlap stand-in for a semantic index. It is not the index,
      // and a passing score here does not guarantee a ranking — but the version
      // this replaced LOST all four, which is exactly what the live session hit.
      const b = await desc("balance");
      const rem = await desc("remaining");
      // Presence alone cannot separate them and should not: `remaining` has to
      // say "not an account balance" to do its job, which puts the word in both.
      // What separates them is what separates them for a real index — how often a
      // term appears and HOW EARLY. A term in the opening clause is the subject; a
      // term in a closing disclaimer is not.
      const score = (d: string, q: string): number =>
        q.split(/\s+/).filter((w) => w.length > 2).reduce((acc, w) => {
          const first = d.indexOf(w);
          if (first < 0) return acc;
          return acc + (d.split(w).length - 1) + 100 / (100 + first);
        }, 0);

      for (const q of ["balance", "my balance", "how much do i have", "wallet balance"]) {
        expect(score(b, q), `"${q}" should favour balance`).to.be.greaterThan(score(rem, q));
      }
    });

    it("neither opens with the sentence that made them interchangeable", async () => {
      const opening = (d: string): string => d.slice(0, 48);
      expect(opening(await desc("balance"))).to.not.equal(opening(await desc("remaining")));
    });
  });

  it("ships a usable JSON Schema with each tool", async () => {
    const { tools } = await client.listTools();
    for (const t of tools) {
      expect(t.inputSchema, t.name).to.have.property("type", "object");
      expect(t.inputSchema, t.name).to.have.property("properties");
      expect(t.description, t.name).to.be.a("string").with.length.greaterThan(40);
    }
  });

  it("tells the model, in the descriptions, the three things it must not assume", async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t.description ?? ""]));

    // Chain text is data, not instructions.
    expect(byName.get("list_assets")).to.match(/untrusted/i);
    // Recipients are public; only amounts are confidential.
    expect(byName.get("send")).to.match(/Recipients are public/i);
    // Going back to a public balance is a disclosure, and its ceiling is weaker
    // than the on-chain one — both have to be said where the model will read them.
    expect(byName.get("unwrap")).to.match(/publishes/i);
    expect(byName.get("unwrap")).to.match(/server/i);
  });

  it("calls a tool that needs no chain and no vault", async () => {
    const result = await client.callTool({ name: "list_assets", arguments: {} });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(result.isError ?? false).to.equal(false);
    expect(content[0]?.text).to.include("gkUSD");
    // list_assets must never carry an amount.
    expect(content[0]?.text).to.match(/No amounts here by design/i);
  });

  it("reports a tool error as isError rather than dropping the connection", async () => {
    // No session is open, so this is the ordinary "you have to open one" path.
    const result = await client.callTool({ name: "session_status", arguments: {} });
    expect(result.isError).to.equal(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).to.match(/no session is open/i);

    // And the connection is still usable afterwards, which is the point.
    const after = await client.listTools();
    expect(after.tools.length).to.equal(EXPECTED_TOOLS.length);
  });

  it("rejects arguments that do not match the schema", async () => {
    const result = await client.callTool({
      name: "can_afford",
      arguments: { token: "gkUSD" }, // amount missing
    });
    expect(result.isError).to.equal(true);
  });

  // Was "unwrap" until unwrap became a real tool, at which point this test was
  // asserting that a shipped tool was missing. The name has to be one that is
  // not going to become real.
  it("rejects an unknown tool by name", async () => {
    const result = await client.callTool({ name: "teleport", arguments: {} });
    expect(result.isError).to.equal(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).to.match(/no such tool/i);
  });

  // -------------------------------------------------------------------------
  // Argument validation before world state, on every tool that takes an argument.
  //
  // The first version of these tools checked the session before the arguments, so
  // can_afford("NOPE") answered "no session is open". A model would open a
  // session, retry, and hit the real error — one wasted vault unlock, which is a
  // physical click. addRecipient was worse: it unlocked the vault BEFORE looking
  // at the address at all, so "add Mehmet to the list" cost a click and returned
  // an ABI encoding error.
  //
  // No session is open in any of these, so a state-first implementation fails
  // every one of them.
  // -------------------------------------------------------------------------
  describe("argument errors are diagnosed before session state", () => {
    const cases: Array<{ tool: string; args: Record<string, unknown>; expect: RegExp }> = [
      { tool: "balance", args: { token: "NOPE", reveal: false }, expect: /gkUSD/ },
      { tool: "remaining", args: { token: "NOPE", reveal: false }, expect: /gkUSD/ },
      { tool: "can_afford", args: { token: "NOPE", amount: "1" }, expect: /gkUSD/ },
      { tool: "can_afford", args: { token: "gkUSD", amount: "not a number" }, expect: /decimal/i },
      { tool: "send", args: { token: "NOPE", to: ZERO, amount: "1" }, expect: /gkUSD/ },
      {
        tool: "send",
        args: { token: "gkUSD", to: "Mehmet", amount: "1" },
        expect: /not an address/i,
      },
      { tool: "add_recipient", args: { to: "Mehmet" }, expect: /not an address/i },
      { tool: "wrap", args: { token: "NOPE", amount: "1" }, expect: /gkUSD/ },
      // The pool tools take an amount that may be a reference, so "is this even
      // an amount" is a question about syntax and has to be answered before any
      // lookup. A model that gets told "no session" for a typo opens one and
      // then hits the same typo.
      { tool: "pool_deposit", args: { amount: "" }, expect: /reference/i },
      { tool: "pool_deposit", args: { amount: "half of it" }, expect: /neither an amount nor a reference/i },
      { tool: "pool_deposit", args: { amount: "bal_1:double" }, expect: /not a reference operation/i },
      { tool: "pool_withdraw", args: { amount: "lots" }, expect: /neither an amount nor a reference/i },
    ];

    for (const c of cases) {
      it(`${c.tool} with ${JSON.stringify(c.args)}`, async () => {
        const result = await client.callTool({ name: c.tool, arguments: c.args });
        expect(result.isError, "should be an error").to.equal(true);
        const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
        expect(text, "must name the bad argument").to.match(c.expect);
        expect(text, "must not blame the session").to.not.match(/no session is open/i);
      });
    }

    it("refuses a name rather than resolving it", async () => {
      // Resolution is a chain call whose answer the user cannot check before
      // signing, and this is the argument where being wrong sends money away.
      const result = await client.callTool({
        name: "add_recipient",
        arguments: { to: "vitalik.eth" },
      });
      const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
      expect(text).to.match(/ENS are not resolved/i);
    });

    it("catches a mistyped address by its checksum", async () => {
      // Right shape, one character wrong. Silently accepting this would be the
      // worst possible failure in the worst possible argument.
      const bad = "0xF505e2E71df58D7244189072008f25f6b6aaE5aF";
      const result = await client.callTool({ name: "add_recipient", arguments: { to: bad } });
      const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
      expect(text).to.match(/checksum/i);
    });
  });

  it("names an unknown token instead of failing obscurely", async () => {
    const result = await client.callTool({
      name: "can_afford",
      arguments: { token: "NOPE", amount: "1" },
    });
    expect(result.isError).to.equal(true);
    const content = result.content as Array<{ type: string; text: string }>;
    // The message has to tell the model what it CAN use, or it will guess again.
    expect(content[0]?.text).to.include("gkUSD");
  });
});

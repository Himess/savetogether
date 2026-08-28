# GhostPool — day 6: the browser pass, and a scope gap I have to own

Self-contained: it repeats the facts it depends on, so it reads without the repo.

**Live:** https://ghostpool-himess.vercel.app
**Pool:** `0x307e2D1eA71C73FD4358622933880868BbCe05D0` (Sepolia)
**Token:** `0x056AC066e0770A7BE08eCAc73C09f811B067fc46`

Two halves. The first is what the browser pass found — three real bugs, all fixed.
The second is a gap between what was built and what the product is supposed to be,
which I created and then obscured with a phrase in the README.

---

## Part 1 — The browser pass found three bugs that nothing else could

Before this, the frontend had: 30 passing local tests, a live end-to-end round on
Sepolia, a clean type check, a successful Vercel build, and a chunk-graph
traversal confirming every panel was served. All of that passed while the first
real user could not complete a single action.

### 1.1 The app said Sepolia while the wallet was on Ethereum

The wallet panel showed a green **SEPOLIA** badge. The draw panel showed the
correct round and randomness. The deposit panel said the pool was **authorised**.
Everything read as healthy. Pressing any button opened the wallet showing
`Chain: Ethereum` and `Not enough gas`, with Sign dead.

**Cause.** `Connect.tsx` read the chain from wagmi's `useChainId()`, which returns
the **configured** chain rather than the connector's. With `chains: [sepolia]` as
the only entry it returns 11155111 unconditionally, so the guard never fired.

The failure compounds because reads and writes take different paths. Reads go
through wagmi's own transport, pinned to Sepolia — so balances, draw state and the
operator flag were all genuinely correct **for Sepolia**. Only writes follow the
wallet's chain.

> The page was right about everything except the one thing that decides whether a
> transaction can succeed.

**Fix.** `lib/chain.ts` exposes `useOnSepolia()`, reading `useAccount().chainId` —
the connector's real chain. Correcting the badge alone would still let a user on
mainnet press Deposit and meet an unpayable transaction, so **every write is gated
on it**: mint, authorise, deposit, withdraw and the decryption permit, each with
"Switch your wallet to Sepolia first."

### 1.2 Withdraw sent 1,000,000× the intended amount

`Deposit` takes raw token units. `Withdraw` multiplied by `1e6`:

```ts
BigInt(Math.round(n * 1e6))   // Withdraw
BigInt(Math.round(n))         // Deposit
```

Asking to withdraw 5 against a balance of 100 sent **5,000,000** to the contract.
The contract clamped it to an encrypted zero — correctly, and by design — so **the
transaction succeeded and moved nothing.**

This is the worst shape a bug can take in this particular product. The clamp is a
deliberate privacy feature: an over-withdrawal must not revert, because a revert
would publish that the account asked for more than it held. So the failure mode is
silent by construction, and a caller passing the wrong units gets a green
transaction and an unchanged balance with no diagnostic anywhere.

### 1.3 The same token was called two different things

`Deposit` said **gUSDC** (the deployed token's actual symbol), `Withdraw` said
**cUSDC**. One token. Cosmetic, but a judge reads it as two.

### 1.4 What this says about the four days before it

Every one of these lives in a place no test could reach: the gap between a read
path and a write path that only exists inside a browser holding a wallet, and a
unit convention that differs between two call sites in a way the type system
cannot see (`bigint` either way).

It is the fourth instance of one pattern in this project — §11.1's cancelling
errors, §14's wrong unit of analysis, §16.3's `as never` cast — and the same
question found it every time: not *does this look right*, but **what is this
actually reading**.

### 1.5 Known and not blocking

- `[zama connector walletClient failed] TypeError: f.getProvider is not a function`
  — the Zama bridge carried over from GhostLend calls `connector.getProvider()`,
  which Rabby does not expose in the expected shape. The fallback path works:
  decryption completed and the deposit landed. Noise, not a blocker.
- Three wallet extensions are fighting over `window.ethereum` in the test browser.
  Disable the others before recording, or every connect shows a wallet picker.
- `favicon.ico` 404.

---

## Part 2 — The scope gap, which is mine

The question was: weren't we building Zama's Confidential Vault plus PoolTogether
plus a conversational MCP layer? Why is this a bare pool with its own token?

Checked against the record rather than from memory.

### 2.1 What is actually built

Weighted winner selection over encrypted balances. The TWAB record, the draw's
commit-reveal, permissionless accrual, and the leakage measurement. **This part is
real and measured** — 306 live accruals, identical operation sequence and HCU,
gas tracking the address rather than the outcome.

### 2.2 What is missing, and I described it dishonestly

**There is no yield. Not a mock — none at all.**

The prize comes from `_reserve`, which I funded by hand with 10,000 tokens in the
deploy script. The contract contains no vault, no yield accrual, and nothing that
connects deposits to prize funding. `grep` for vault, yield or harvest in
`ConfidentialPrizePool.sol` returns three hits, all of them in comments.

My own step-1 reuse inventory listed GhostLend's `MockYieldVault.sol` (27 lines)
as transferring **"as-is"**. I never wired it. Then I wrote "yield is mocked" in
the README, which is not true and reads as though something is there.

**So what exists today is a lottery with a pre-funded pot, not no-loss prize
savings.** The bounty's own wording is "yield funds a prize pool", and a judge
comparing that sentence to the contract will find nothing behind it.

### 2.3 What was cut deliberately, and by whom

The conversational / MCP layer was removed by explicit instruction in the day-3
brief, verbatim:

> "GhostKey is out of scope for you entirely. It is handled separately. Do not
> build the conversational surface, do not reserve time for it."

Following that, §5.5 of `findings.md` withdrew the earlier claim that the design
*required* GhostKey. That one is not a gap — it is a decision, and it is recorded.

### 2.4 Why the real vault would not have helped anyway

A9, measured on chain: Zama's Confidential Vault **is** deployed on Sepolia —
ERC-4626 vault `0x6AB54988261AEC573a2CA13cF802d3B1114f864C`, cShare
`0x7E93d5c150A2178B1fCde0278582Acf59478eA5f`, deposit and redeem batchers, block
11117640 — but it is a **staging instance with an idle-only VaultV2 and no yield
adapter**. It generates zero yield.

So a mock was always going to be required. That does not excuse not building one;
it just means the missing piece is the mock, not the integration.

---

## Part 3 — The decision

### Option A — wire the yield source

Pool deposits idle principal into `MockYieldVault`; the vault accrues at a rate;
`harvest()` pulls the yield into `_reserve`. The prize then genuinely comes from
yield, and **"your principal is never at risk, only the yield funds prizes"**
becomes demonstrable rather than asserted.

Cost: roughly half a day — contract, tests, redeploy.

**It does not invalidate the measurement.** The frozen surface is `accrue`,
`_snapshotCumulative`, `_cumulativeAt`, `thresholdFor` and `_uniform`. None of
them is touched; `harvest()` and the vault plumbing sit beside them. The 306-sample
equality result stands.

### Option B — ship as is, and say so plainly

Correct the README to state that the prize is paid from a pre-funded reserve, that
the yield integration is designed but not connected, and that Zama's deployed
vault produces no yield to connect to. Spend the day on the video and the thread,
both of which are hard submission requirements and neither of which exists yet.

### My recommendation

**Option A.** The difference between "prize pool" and "no-loss prize savings" is
exactly this piece, it is the bounty's own framing, and it costs half a day
without touching the measured surface.

But it is a scope call against a deadline with the video and the X thread still
outstanding, so it is not mine to make alone.

---

## Where things stand

| | |
| --- | --- |
| Contract | deployed, 30 local tests, one full live round |
| Measurement | 306 live accruals; operation sequence and HCU identical; gas tracks address not outcome (Welch p = 0.35) |
| Frontend | deployed and public; three browser-pass bugs found and fixed |
| Yield | **absent** |
| Conversational layer | cut by instruction |
| Video | not started |
| X thread | not started |
| Budget | ~0.78 ETH Sepolia |

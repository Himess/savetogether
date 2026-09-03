# O1 — what the contracts can answer, against what the screens ask

**57 readable getters across the three contracts. 17 are read by a screen. 40 are not.**

Built from the compiled artifact ABIs, not from the Solidity source and not from memory.
The first attempt regexed the sources and **missed `accrued`** — a nested mapping's
generated getter does not match a pattern written for a flat one — and `accrued` turned
out to be the most important row in the table. That near-miss is the point of doing this
mechanically: the gap being measured is exactly the one that memory produces.

Method: every `view`/`pure` function in the artifact ABI, plus every non-view function
returning an FHE handle (`weightFor` and `cumulativeAt` are readable *after* the call that
grants them). Each is searched for across `frontend/**` — separating `lib/abis.ts`, which
only declares, from the screens, which actually call.

The third column is a judgement and it says **no** 22 times. A getter nobody wants is not
a gap, and a table that called everything a gap would be useless.

---

## The gaps that matter

| getter | kind | in ABI | on a screen | would a user want it? |
|---|---|---|---|---|
| `Pool.accrued(drawId, user)` | view, **plaintext** | **yes** | **no** | **Yes — the worst one.** See below. |
| `Pool.observationCount(user)` | view | — | no | **Yes.** With `observationAt`, this is the user's own TWAB record. |
| `Pool.observationAt(user, i)` | view | — | no | **Yes.** Timestamp + balance handle + cumulative handle per entry. |
| `Pool.cumulativeAt(user, t)` | grant+read | — | no | **Yes.** Confirmed readable by its owner in the F1 sweep, used nowhere. |
| `Pool.minPeriod` | view | — | no | **Yes.** The draw clock has no source without it. |
| `Pool.tiersSetAt` | view | — | no | **Yes.** When the prizes were last allowed to move. |
| `Pool.TIER_CHANGE_INTERVAL` | view | — | no | **Yes**, with the above — the bound is the trust property. |
| `Pool.MAX_PRIZE_MULTIPLE` | view | — | no | **Yes**, same pair: prizes cannot more than double per change. |
| `Pool.keeperFee` | view | — | no | **Yes.** What the keeper takes before a prize is paid. |
| `Pool.owner` | view | **yes** | no | **Yes.** Whether ownership is renounced is a one-word trust fact. |
| `Source.lastAccrual` | view | — | no | **Yes.** Feeds "when the next harvest can happen". |
| `Session.sessionOf(key)` | view | **yes** | **no** | **Yes.** Expiry and transaction count, on the screen that opens sessions. |
| `Session.recipientsOf` / `tokensOf` / `isRecipientAllowed` | view | — | no | **Yes.** The allowlist is the security argument and is invisible. |
| `Session.protocolStatus` | view | — | no | **Yes.** Paused / key denied / module denied — the reasons a send fails. |

### `accrued` is the one that makes the product look broken

It is **plaintext, public, already in the ABI, and called by nothing**.

Without it, a participant whose `winningsOf` has not moved cannot tell which of two
things happened:

- they were accrued and did not win — **correct behaviour**, or
- the keeper has not reached them yet — **an outage**.

Those look identical. One is the design working and the other is the service being down,
and the screen currently offers no way to separate them. Everything else in this table is
an improvement; this one is a correctness problem in the interface.

It costs one `useReadContract` per draw and renders as two words: **processed** or
**waiting**.

### The TWAB record is the only place the core claim becomes visible

The product's claim is *how much **and for how long***. `observationCount` +
`observationAt` + `cumulativeAt` are the record of exactly that — every deposit and
withdrawal, with the cumulative weight between them — and all three are readable by their
owner. Nothing reads any of them. Right now "and for how long" is asserted in prose and
shown nowhere.

---

## Would not want it — and why

Writing this column honestly is what makes the one above worth reading.

| getter | why not |
|---|---|
| `confidentialProtocolId` (all three contracts) | Interface-detection plumbing. Means nothing to a holder. |
| `Session.eip712Domain` | Signing plumbing, consumed by the wallet, never by a person. |
| `Session.openSessionDigest` | An intermediate value inside the open flow. |
| `Session.MAX_RECIPIENTS`, `MAX_TOKENS` | Constants that only matter as an error message when you exceed them, which the error already says. |
| `Pool.indexAt` | An internal binary-search helper over the observation array. |
| `Pool.genesis` | The deploy timestamp. Real, and nobody is asking. |
| `Pool.TIERS` | The constant `3`. Already evident from the three tiers on screen. |
| `Pool.totalObservationCount` | Counts *observations*, not participants — showing it as a participant count would be wrong, and as an observation count it is meaningless to a user. |
| `Source.controller`, `depositBatcher`, `redeemBatcher`, `shareToken`, `token` | Addresses the frontend already hardcodes. *See the note below — reading them is worth something, but not as a display.* |
| `Source.harvest`, `redeem`, `supply` | State-changing. They return handles but they are not display values. |
| **`Pool.pendingOf`** | **Deliberately not shown.** F1 established the holder cannot decrypt it in any state; the SDK no longer offers it as spendable. Showing an eternally-`•••` field would be worse than omitting it. |
| **`Pool.reserveHandle`**, **`Source.principal`**, **`Source.inVault`** | Same reason: the F1 sweep found all three unreadable **by anyone**. They cannot be displayed because nobody can decrypt them. Reserve health has to come from a different route — see below. |

### One "no" that is really a "not like this"

`Source.controller`, `depositBatcher`, `redeemBatcher`, `shareToken` and `token` are not
worth *displaying* — the frontend already hardcodes those addresses. But reading them and
**comparing** them to what the frontend hardcodes is worth something: it is exactly what
`scripts/check-addresses.ts` does off-chain, and doing it in the browser would catch a
stale frontend against a redeployed contract at the moment a visitor loads the page. That
is a verification feature, not a display feature, and it belongs on the Verify screen.

### Reserve health, and why it cannot be read directly

D13 proposed showing *the reserve currently covers N grand prizes*. `reserveHandle` cannot
supply it — the F1 sweep found it granted to nobody. The figure has to come from where the
keeper gets it: the source's accrual rate and elapsed time, which are public
(`rateBps`, `lastAccrual`), against the public `tierPrize` values. That is derivable in the
browser today and leaks nothing, because it is a *state* rather than a per-draw outcome.

---

## The MCP surface, same question

What a tool returns that no screen shows:

| tool | returns something no screen shows |
|---|---|
| `session_status` | expiry, transaction count and cap, the allowlist, and the readiness reasons. **None of it is on the Chat screen**, which is the screen about sessions. |
| `pool_status` | round, state, prize, `snapshotAt`. The Pool screen shows most of this; the frozen-weights timestamp is the exception. |
| `can_afford` | the coarsened yes/no. Deliberately model-facing only. |
| `vault_status` | open batches and redeems — the Vault screen does show these. |

The asymmetry runs one way: **the conversational layer can answer questions the site
cannot.** For a product whose argument is that both front doors reach the same contracts,
that is backwards.

---

## Your question: can anyone see the result?

No — and the nuance is the product, and it is invisible.

**Thresholds are public.** `thresholdFor(drawId, user, tier)` is a `view` returning
`uint128`, computable by anyone for any address in any draw. A stranger can compute your
threshold exactly.

**Weights are not.** `weightFor(drawId, user)` returns a handle only its owner can decrypt.

So an observer holds one half of the comparison and can never obtain the other. That is a
sharper and more checkable statement of the privacy boundary than any prose on the site,
every number in it already exists, and the Verify screen already computes both — it just
never says *this half is public and that half is yours*.

---

## Summary

| | count |
|---|---|
| Readable getters | 57 |
| Read by a screen | 17 |
| Not read, and a user would want it | 18 |
| Not read, and correctly so | 22 |

The 18 fall into five groups: **accrual state** (the correctness one), **the user's own
TWAB record**, **draw history**, **public parameters and the clock**, and **session
visibility**. Nothing in the list needs a contract change — all 57 are live on the
deployed contracts today.

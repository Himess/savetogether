# GhostKey — what the clean-machine run broke, and what is left before E

Self-contained: it repeats the facts it depends on, so it reads without the repo.

State: **90 tests passing** (`pnpm test:all`), 17 SDK integration tests against live
Sepolia, typecheck clean across all four packages, lint clean.

---

## 1. The clean-machine run

`E on a dirty machine tests nothing` was the right call, and the run found something.

### How it was made clean

`USERPROFILE`, `HOME`, `APPDATA` and `LOCALAPPDATA` were pointed at a directory that
had never seen GhostKey, and `GHOSTKEY_CONFIG` was removed from the environment. The
CLI reads **no repo `.env`** — `grep -rn dotenv packages/*/src/` returns nothing — so
the RPC URL came only from the `--rpc` flag, the way a real first run supplies it.
Nothing on this machine's real profile could make the run look like it worked.

### What worked first time

```
init exit 0
config written: true
vault files:    config.json, vault
console url:    ok
```

`~/.ghostkey/config.json`, the vault, and `~/AppData/Roaming/Claude/claude_desktop_config.json`
were all written. `ghostkey status` read them back.

### What broke: the vault panel was empty

The console opened and showed **dashes where the address should be**, and no mint
control. On a first run that is the whole point of the page — you open it to find out
where to send Sepolia ETH — so this was a first-run blocker, not a cosmetic bug.

**Cause.** `ConsoleServer.start()` kicked off `onVault()` in the background, but
`createServer` assigns `holder.tools` _after_ `start()` returns. The fetch therefore
always lost the race, threw `"not ready"`, and was swallowed by a silent `catch`. The
page then showed dashes forever unless the user pressed Refresh — which on a first
run is the one thing they have no reason to do, because they have nothing to compare
against and no reason to think anything is wrong.

**Fix, in two parts.** `refreshVault()` is now an explicit public method, invoked once
the tools exist rather than from inside `start()`. And a failed read is recorded in
`vaultError` and rendered — `could not read the vault: …` — instead of being caught
and dropped. Dashes with no explanation are worse than an error message; they are
indistinguishable from a vault that is genuinely empty.

**Re-verified on a second clean home:**

```
vault panel   POPULATED 0x6aC0d84A0f88Dce6b80848f8D1c187e2bA21f04D
gas           0.0 ETH
network       Sepolia (11155111)
vaultError    none
cap default   50
mint offered  yes
```

### The gap that first run left, now closed

The first clean run proved `init` **writes** a keystore. It did not prove one can be
**read**, because the console only displays the address and `Vault.address()` returns
it from a listing without decrypting anything.

That distinction is not academic. It is the exact shape of the DPAPI bug found
earlier by hand: every vault created on Windows was written fine and was unopenable,
and the error said _"no passphrase found"_ — a message about the wrong thing.

So the run was repeated with an unlock at the end, against a vault created seconds
earlier in a home directory that had never seen GhostKey:

```
advertised 0x0a2644f83D43193B2FD6103cDC5d4AAEDe966bbA
unlocked   0x0a2644f83D43193B2FD6103cDC5d4AAEDe966bbA
match      YES
```

Create, encrypt to DPAPI, read back, decrypt, and derive the same address. That path
is now exercised on a machine with no prior state.

---

## 2. Relayer retry, moved into the SDK

The relayer drops connections. This is measured, not hypothetical: a 60-sample gate
run died on its fifth send with `UND_ERR_CONNECT_TIMEOUT`. A session client that dies
on one of those is unusable, and a demo recorded in real time cannot be re-cut around
it.

`withRetry` now wraps the five transport calls in `packages/sdk/src/fhe.ts`:
`warmInput`, `encryptMany`, `userDecrypt`, `delegatedUserDecrypt`, `userDecryptBool`.
Four attempts, exponential backoff from 1s.

**The split matters more than the retry.** Only transport failures are retried —
connection resets, socket hangups, DNS failures, 429/502/503/504. A revert, a rejected
proof or a failed assertion surfaces immediately and untouched, because retrying one
of those turns a clear error into a slow one and could resubmit something that already
had an effect.

Four tests pin this, in the committed suite rather than ad hoc:

```
✔ recovers from a transport failure
✔ does not retry a revert
✔ gives up eventually, and says how many times it tried
✔ classifies transport failures apart from rejected requests
```

The third exists because a retry that gives up silently reports the last attempt's
error as if it were the only one; the message now carries `[encrypt: gave up after 3
attempts]`.

---

## 3. The cap, demoted

`docs/leakage.md` §3 argued the transfer cap as a second independent bound on the
timing channel. **That argument is retired**, and the section now reads in the right
order: the finding first, the cap after it, labelled as what it now is.

The finding is that there is nothing detectable to accumulate — χ² 0.374 at p = 0.83,
mutual information 0.00151 bits against a 0.00801-bit Miller–Madow noise floor.
Presenting the cap as a defence would be mounting a guard against a concern the
measurement already dissolved.

The cap stays, at the default of 50, as an owner-set bound on a channel nobody has
shown to exist. The same correction was applied to the pushback in
`docs/step5-report.md` §9, which had argued the same retired point.

What survives of that pushback is smaller and is not about leakage: a session with no
cap has no ceiling on how much it can do before its TTL expires, and a user who never
opens the console never sets one.

---

## 4. The counter increment is evidence — and now says so

The earlier pushback had the sign backwards, and it has been withdrawn in
`docs/step5-report.md` §9 rather than quietly dropped.

A counter that never moves proves nothing; it could be a constant with a label on it.
One that moves **exactly when the owner authorises something and never otherwise** is
a measurement. `wrap` and `add_recipient` each costing another unlock is not a wart to
be explained away before a demo — it is the demonstration that the counter is wired to
the thing it claims to count.

This is stated plainly in `docs/architecture.md` ("An instrument, not a decoration")
and in the README.

**Acted on, not just conceded.** A hardcoded `1 session` on the console would have been
the same "constant with a label on it" the argument is against. So each unlock now
records _what it bought_ — `session`, `recipient`, `wrap` — and the console derives the
note from that ledger:

```
1 session · 1 recipient added · the vault locked again after each
```

An increment is now attributable rather than drift.

Four tests pin the rendering, and they run the shipped `renderStatus` extracted from
the served page rather than a copy of its logic — a test against a copy would pass
while the page said something else.

---

## 5. Evidence page

`an observer learns nothing` → `learns nothing measurable`, in both
`docs/evidence.html` and `docs/leakage.md`. The stronger claim was not the one the
measurement supports, and the weaker one is still the strongest available: the
estimate sits below the noise floor for its own sample size.

`docs/evidence-card.html` is new: the three headline stats and the gate table in one
16:9 frame, sized for a screenshot. Everything inside it is in `em` and the frame is
`60em × 33.75em`, so it scales from a single `font-size` — at 20px that is exactly
1200×675. Dark only, deliberately: a card that renders differently depending on who
screenshots it is not a card.

The bottom strip carries the three things a sceptic asks in order — not
distinguishable (χ², p), below the noise floor (MI vs Miller–Madow), and powered to
have found it (±13 points, the exact spread the n = 20 run appeared to show).

---

## 6. What is left before E can be run start to finish

**Nothing in the code.** The blockers are setup, and they are yours because they need
your keys and your chat client.

1. **Run E on your normal profile, not a clean one.** The clean runs each generated a
   fresh throwaway vault with 0.0 ETH. Your real vault is already funded.
2. **Confirm the vault has Sepolia ETH and test tokens.** `ghostkey console` shows the
   gas balance and offers the mint control. Both are setup, which is why they live on
   the page and not in a tool call — you want the address before you have anything to
   say.
3. **Have the console open in a browser before you start talking.** Opening a session
   raises an unlock, and an unlock is a click. There is no path by which a model can
   supply it: a tool call cannot press a button, and stdin belongs to the MCP
   transport rather than to a conversation.

### What E will hit that nothing else has

- **The ten tool descriptions.** They have never met a user. This is the largest
  untested surface in the system, and it is not a code path — it is the product's
  actual interface.
- **The Turkish path specifically.** The descriptions are English. Whether a model
  goes from a Turkish request to the right tool is untested, which is why running the
  two languages separately is the right design and not redundant.
- **Recovery from a refusal.** Whether the spend-only tier's refusal to read a balance
  is understandable from the error alone, or whether the model retries pointlessly.
- **What a model asks for after a crash.** There is still no `history()`. Its shape
  should be decided _after_ E, because what the model reaches for determines what the
  method needs to return.

### Deliberately still open

- EIP-5792 batching is implemented and **unverified against a live wallet**. The
  product path does not use it — there is no browser wallet in it.
- No confirmation-depth policy anywhere. Acceptable on Sepolia; not on mainnet.
- The README's "tool surface" section and the quickstart transcript are stubbed, with
  the reason visible in the file: both quote wording that E is expected to change.

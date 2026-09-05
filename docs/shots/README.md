# Screenshots for the README's disclosure section

Five captures from one hosted session on 2026-09-05, referenced from `README.md` under
**Talking to it → What it looks like**. All five are here; the captions live there.

| file | what it shows |
|---|---|
| `refusal.png` | Asked for a balance, declining — then asked to narrow it down by trying amounts, declining again, **unprompted**. Both refusals in one frame. |
| `reference.png` | A deposit made against `bal_1:half`, with no figure anywhere in the context — and a timeout **after** the transaction landed, which the session declined to retry. |
| `budget-refusal.png` | A 900 deposit refused by `can_afford` before anything was sent, with the coarsening reasoned about and a second refusal to sweep it. |
| `unwrap-warning.png` | An unwrap performed on request, and the model naming the one asymmetry in the system: the disclosure path is server-enforced while the confidential paths are contract-enforced. |
| `connector.png` | The tool surface a connector exposes, one permission control per row. |

## Three captions were wrong until the captures landed

Worth recording, because it is the risk of writing a caption before its evidence
exists. All five were described in the README months before they were taken, and when
they arrived three of the descriptions were contradicted by their own frames:

- **`budget-refusal.png`** was captioned *"the clamp is on chain"*. The frame shows the
  request never leaving — `can_afford` refused it first, so the on-chain clamp never
  fired. Two different mechanisms, and the caption named the wrong one.
- **`unwrap-warning.png`** was captioned *"unwrapping publishes the amount, so it is
  not a session tool at all"*. The frame is a session performing an unwrap. The claim
  was contradicted by the image placed under it.
- **`connector.png`** was captioned *"revoke from your own wallet to close … shown
  rather than asserted"*. The frame contains no revoke. It shows the tool list.

Each is now captioned for what its frame actually contains. **A caption that overstates
its own screenshot is worse than no screenshot**, because a reader who checks finds the
gap and stops trusting the captions that were accurate.

## On the first one

It is evidence of a model choosing well, not of a system preventing a choice — and the
caption says so in that order deliberately. Nothing in the tool descriptions instructs
a model not to binary-search a balance. The behaviour emerged from descriptions that
explain what references are *for*. Since `can_afford` was coarsened (G1) the system
bounds it too, so the screenshot is no longer the only thing standing between a curious
model and a budget. Both facts belong in the frame.

The capture also carries an argument neither half covers: the probe amounts would be
**public on chain**, so a bisection search publishes the balance to every observer, not
just to the model. That is not in any tool description either.

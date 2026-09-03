# Screenshots for the README's disclosure section

Five captures, referenced from `README.md` under **Talking to it → What it looks
like**. The captions are already written there; these are the images they sit under.

| file | what to capture |
|---|---|
| `refusal.png` | The model asked for a balance, declining — then asked to narrow it down by trying amounts, declining again, **unprompted**. Both refusals in one frame if possible; the second is the one that matters. |
| `reference.png` | A `pool_deposit` tool call carrying `bal_1:half`, with the model's context visible above it and **no figure anywhere in it**. |
| `budget-refusal.png` | A send or deposit that exceeds the encrypted budget, refused. |
| `unwrap-warning.png` | The unwrap warning — that it publishes the amount, and that it is not a session tool. |
| `connector.png` | Connector setup, and the revoke afterwards. |

Drop the files in with these exact names and the README picks them up; the HTML
comments above each caption mark the insertion points.

**On the first one.** It is evidence of a model choosing well, not of a system
preventing a choice — and the caption says so in that order deliberately. Nothing in
the tool descriptions instructs a model not to binary-search a balance. The behaviour
emerged from descriptions that explain what references are *for*. Since `can_afford`
was coarsened (G1) the system bounds it too, so the screenshot is no longer the only
thing standing between a curious model and a budget. Both facts belong in the frame.

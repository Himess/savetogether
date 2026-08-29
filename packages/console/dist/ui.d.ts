/**
 * The console page. One file, no build step, no framework.
 *
 * The conversation is the interface. This page exists for the things that must
 * not happen in chat — unlocking the vault, confirming a reveal, typing an amount
 * that must stay out of the transcript — and for the setup a chat window is a bad
 * place to do: funding the vault and minting test tokens.
 *
 * The unlock counter is the most important element on it. It is the product's
 * central claim rendered as a number, and the thing a viewer checks first, so it
 * counts what the claim is actually about. With both keys on this machine the
 * vault SIGNS three transactions per session; what happens once is the unlock.
 * A counter reading "signatures: 1" would be false.
 */
export declare function consoleHtml(token: string): string;

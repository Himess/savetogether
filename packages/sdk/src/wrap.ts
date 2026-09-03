import { Contract, type Signer } from "ethers";
import { AmountRef, attachResolver } from "./amounts";
import { type FhevmInstance, userDecrypt, warmInput } from "./fhe";

/**
 * Turning public money into confidential money, for whoever the session acts as.
 *
 * The local product wraps for the OWNER, because the owner holds the public
 * balance and a vault unlock is the honest price of moving it. Hosted there is
 * no vault and no owner key, so the account that acts is the session key — it
 * holds its own position, and wrapping into that position is an ordinary thing
 * for it to do.
 *
 * Same tool, same meaning in both: make the money this session can spend
 * confidential. What differs is only which account holds it, which is the same
 * distinction the rest of the hosted design already turns on.
 *
 * WRAPPING IS PUBLIC and no arrangement here changes that. An observer sees the
 * ERC-20 transfer into the wrapper and the amount in the clear. What they stop
 * seeing is everything afterwards.
 */

const WRAPPER_ABI = [
  "function wrap(address to, uint256 amount) returns (bytes32)",
  "function confidentialBalanceOf(address) view returns (bytes32)",
  "function unwrap(address from, address to, bytes32 amount, bytes inputProof)",
  "function underlying() view returns (address)",
  "function rate() view returns (uint256)",
];

const ERC20_ABI = [
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

export interface WrapContext {
  readonly fhevm: FhevmInstance;
  readonly signer: Signer;
  readonly signerAddress: string;
  readonly wrapperAddress: string;
}

export interface WrapResult {
  readonly hashes: readonly string[];
  readonly steps: readonly string[];
  readonly underlyingAddress: string;
}

export class WrapClient {
  constructor(private readonly ctx: WrapContext) {}

  private get wrapper(): Contract {
    return new Contract(this.ctx.wrapperAddress, WRAPPER_ABI, this.ctx.signer);
  }

  /** The public token this wrapper is over, read from the wrapper itself. */
  async underlying(): Promise<string> {
    return this.wrapper.underlying!();
  }

  async publicBalance(): Promise<{ amount: bigint; decimals: number; address: string }> {
    const address: string = await this.underlying();
    const token = new Contract(address, ERC20_ABI, this.ctx.signer);
    return {
      amount: await token.balanceOf!(this.ctx.signerAddress),
      decimals: Number(await token.decimals!()),
      address,
    };
  }

  /** The confidential side, as a reference the caller can spend but not read. */
  async confidentialBalance(): Promise<AmountRef> {
    const handle: string = await this.wrapper.confidentialBalanceOf!(this.ctx.signerAddress);
    const ref = new AmountRef(handle, this.ctx.wrapperAddress, "balance");
    return attachResolver(ref, () =>
      userDecrypt(this.ctx.fhevm, this.ctx.signer, handle, this.ctx.wrapperAddress),
    );
  }

  /**
   * Mints the test underlying, approves, and wraps.
   *
   * Each precondition is handled rather than discovered. E1 measured what this
   * contract does when one is missing — a bare `execution reverted` with nothing
   * decodable in it — and a model that meets that has nothing useful to say to
   * the person waiting.
   *
   * The faucet step is testnet-only by nature: the underlying here is a mock
   * with a permissionless `mint`, capped per call. On a real deployment the
   * caller brings their own and this step simply never runs.
   */
  async wrap(amount: bigint, opts: { faucet?: boolean } = {}): Promise<WrapResult> {
    const underlyingAddress: string = await this.underlying();
    const token = new Contract(underlyingAddress, ERC20_ABI, this.ctx.signer);
    const hashes: string[] = [];
    const steps: string[] = [];

    const held: bigint = await token.balanceOf!(this.ctx.signerAddress);
    if (held < amount) {
      if (opts.faucet !== true) {
        throw new Error(
          `this account holds ${held} of the underlying and wrapping needs ${amount}`,
        );
      }
      const tx = await token.mint!(this.ctx.signerAddress, amount - held);
      await tx.wait();
      hashes.push(tx.hash);
      steps.push("minted the test underlying from its public faucet");
    }

    const allowance: bigint = await token.allowance!(
      this.ctx.signerAddress,
      this.ctx.wrapperAddress,
    );
    if (allowance < amount) {
      const tx = await token.approve!(this.ctx.wrapperAddress, amount);
      await tx.wait();
      hashes.push(tx.hash);
      steps.push("approved the wrapper");
    }

    const tx = await this.wrapper.wrap!(this.ctx.signerAddress, amount);
    await tx.wait();
    hashes.push(tx.hash);
    steps.push("wrapped");

    return { hashes, steps, underlyingAddress };
  }

  /**
   * Confidential money back into public money.
   *
   * THE CEILING ON THIS IS SERVER-SIDE AND CANNOT BE ANYTHING ELSE, which is a
   * property of the deployed wrapper rather than a choice made here. Read at the
   * implementation behind the proxy (0xAe37b998…, 22183 bytes), the only unwrap
   * it carries is
   *
   *     unwrap(address,address,bytes32,bytes)      0x5bf4ef06   present
   *     unwrap(address,address,uint64)             0xf5c3c5f0   absent
   *
   * so every unwrap takes an externally encrypted input with a proof, and a
   * proof is bound to the (contract, user) pair that produced it. A contract
   * cannot forge one. That rules out the arrangement used everywhere else in
   * this product — a budget module standing between the session and the token,
   * enforcing a limit the session cannot exceed — because the module would have
   * to originate the input and it cannot.
   *
   * So the limit lives with whoever encrypts, and that is this process. It is a
   * weaker guarantee than the on-chain budget and it is named as such wherever
   * it is surfaced, rather than being presented as the same kind of promise.
   *
   * UNWRAPPING IS PUBLIC, in the exact sense wrapping is: the amount leaves the
   * encrypted domain and is readable in the transaction. It is a disclosure, and
   * the caller is told so before it happens.
   */
  async unwrap(amount: bigint): Promise<{ hash: string; underlyingAddress: string }> {
    const underlyingAddress: string = await this.underlying();
    const { handle, inputProof } = await warmInput(
      this.ctx.fhevm,
      this.ctx.wrapperAddress,
      this.ctx.signerAddress,
      amount,
    ).ready;

    // from and to are both this account: the confidential balance debited is
    // its own, and the public balance credited is its own.
    const tx = await this.wrapper.unwrap!(
      this.ctx.signerAddress,
      this.ctx.signerAddress,
      handle,
      inputProof,
    );
    await tx.wait();
    return { hash: tx.hash, underlyingAddress };
  }
}

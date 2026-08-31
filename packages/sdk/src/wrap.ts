import { Contract, type Signer } from "ethers";
import { AmountRef, attachResolver } from "./amounts";
import { type FhevmInstance, userDecrypt } from "./fhe";

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
}

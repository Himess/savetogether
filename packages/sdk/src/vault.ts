import { Contract, type Signer } from "ethers";

/**
 * GhostPool's adapter on Zama's deployed confidential vault.
 *
 * WHAT THIS IS AND IS NOT, because the difference is the whole value of it.
 * Joining moves the adapter's held balance into the vault's next deposit batch
 * and, when Zama's keeper dispatches it, real shares come back. That composes,
 * and it is proved on chain. It also earns NOTHING: Zama's Sepolia vault is a
 * mock, which was measured rather than assumed, and it is not the mainnet
 * Steakhouse x Morpho vault.
 *
 * So a tool over this should describe a composability action, not a yield
 * opportunity. Anything that let a model tell a user their money is "earning" in
 * here would be the one dishonesty that discredits the rest.
 *
 * Both operations are PERMISSIONLESS by design. `supply` is the pool's private
 * business and is not exposed here; joining and claiming are things anyone may
 * do because neither can move value anywhere the adapter did not already choose.
 */

const ADAPTER_ABI = [
  "function joinVault() returns (uint256)",
  "function claimShares(uint256 batchId)",
  "function openBatches() view returns (uint256[])",
  "function asset() view returns (address)",
];

const BATCHER_ABI = [
  "function currentBatchId() view returns (uint256)",
  "function batchState(uint256 batchId) view returns (uint8)",
];

/** The batcher's own lifecycle, in the order it happens. */
const BATCH_STATE = ["open", "dispatched", "settled"] as const;

export interface VaultContext {
  readonly signer: Signer;
  readonly adapterAddress: string;
  readonly batcherAddress?: string;
}

export interface VaultStatus {
  readonly openBatches: readonly number[];
  readonly currentBatchId: number | null;
  readonly currentState: string | null;
}

export class VaultClient {
  constructor(private readonly ctx: VaultContext) {}

  private get adapter(): Contract {
    return new Contract(this.ctx.adapterAddress, ADAPTER_ABI, this.ctx.signer);
  }

  async status(): Promise<VaultStatus> {
    const open = (await this.adapter.openBatches!()) as readonly bigint[];
    if (this.ctx.batcherAddress === undefined) {
      return {
        openBatches: open.map(Number),
        currentBatchId: null,
        currentState: null,
      };
    }
    const batcher = new Contract(this.ctx.batcherAddress, BATCHER_ABI, this.ctx.signer);
    const id = Number(await batcher.currentBatchId!());
    const raw = Number(await batcher.batchState!(id));
    return {
      openBatches: open.map(Number),
      currentBatchId: id,
      currentState: BATCH_STATE[raw] ?? `state ${raw}`,
    };
  }

  /** Puts whatever the adapter holds into the vault's next batch. */
  async join(): Promise<string> {
    const tx = await this.adapter.joinVault!();
    await tx.wait();
    return tx.hash;
  }

  /** Collects shares once a batch has settled. Fails loudly if it has not. */
  async claim(batchId: number): Promise<string> {
    const tx = await this.adapter.claimShares!(batchId);
    await tx.wait();
    return tx.hash;
  }
}

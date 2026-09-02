# Deploying the keeper

The keeper runs from its own checkout at `/opt/ghostpool-keeper`, with its own
`node_modules` and its own compiled artifacts. That matters more than it sounds
like it should.

```bash
scp scripts/keeper.ts                root@HOST:/opt/ghostpool-keeper/scripts/
scp contracts/ConfidentialPrizePool.sol \
    contracts/SteakhouseReplicaSource.sol \
                                     root@HOST:/opt/ghostpool-keeper/contracts/
ssh root@HOST 'cd /opt/ghostpool-keeper && HOME=/opt/ghostpool-keeper npx hardhat compile'
ssh root@HOST 'systemctl restart ghostpool-keeper'
```

## Copy the contracts, not just the script

`ethers.getContractAt` builds its interface from the LOCAL artifact, so a keeper
running new code against old artifacts silently loses every function added since
they were compiled. After tiers shipped, the break-even diagnostic came back as

```
[keeper] break-even line unavailable: pool.TIERS is not a function
```

— the script was current and the ABI was not. The failure is quiet by nature: the
transactions the keeper *does* send still work, because those selectors have not
changed, so only the new reads break and only where someone is looking.

**It reported itself, which is the only reason it was found.** An earlier version
of that function wrapped everything in `catch {}` and the same breakage produced
no line at all.

## `HOME` has to be set

The unit runs with `ProtectHome=true`, so hardhat cannot write `~/.config` and
fails with `EROFS: mkdir /root/.config`. `Environment=HOME=/opt/ghostpool-keeper`
in the unit file, and the same on the command line when compiling by hand.

## It shares the deployer key

Stop it before running anything that sends a transaction from the same account, or
both race for the nonce and one comes back `replacement transaction underpriced`.

```bash
ssh root@HOST 'systemctl stop ghostpool-keeper'
# ... deploy, seed, join, measure ...
ssh root@HOST 'systemctl start ghostpool-keeper'
```

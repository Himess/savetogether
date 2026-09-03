"use client";
import { useMemo } from "react";
import { useAccount, useBalance, useReadContract } from "wagmi";
import { useDecryptValues, useGrantPermit, useHasPermit } from "@zama-fhe/react-sdk";
import { css } from "@/lib/css";
import { shortAddr, showConfidential, showPublic } from "@/lib/format";
import { CUSDC, EXPLORER, POOL, USDC, VAULT_SHARE } from "@/lib/addresses";
import { ERC20_ABI, ERC7984_ABI, POOL_ABI } from "@/lib/abis";
import { useOnSepolia } from "@/lib/chain";
import { TokenIcon } from "@/components/TokenIcon";

const ZERO = "0x0000000000000000000000000000000000000000000000000000000000000000";

/**
 * Everything you hold, public and confidential side by side.
 *
 * The split is the point rather than a layout choice: two of these rows are
 * readable by anyone with an RPC endpoint and the rest are not, and seeing them
 * in one table is the clearest statement of what the product actually changes.
 * One signature covers every confidential row — it is an EIP-712 permit kept in
 * this browser, not a key and not something the server ever sees.
 */
export function BalancesScreen() {
  const { address } = useAccount();
  const onSepolia = useOnSepolia();
  const enabled = !!address;

  const { data: eth } = useBalance({ address, query: { enabled } });
  const { data: usdc } = useReadContract({
    abi: ERC20_ABI, address: USDC, functionName: "balanceOf",
    args: address ? [address] : undefined, query: { enabled },
  });

  // Three rows, not four: the pool settles in cUSDC, so the wallet row and the
  // pool's token row were the same contract read twice under two names.
  const conf = [
    { label: "cUSDC", sub: "Zama's confidential wrapper — the token this pool settles in", token: "cUSDC", contract: CUSDC, abi: ERC7984_ABI, fn: "confidentialBalanceOf", decimals: 6 },
    { label: "In the pool", sub: "your position, earning weight over time", token: "cUSDC", contract: POOL, abi: POOL_ABI, fn: "confidentialBalanceOf", decimals: 6 },
    { label: "Won, all time", sub: "credited automatically — claiming is optional and reveals nothing", token: "cUSDC", contract: POOL, abi: POOL_ABI, fn: "winningsOf", decimals: 6 },
  ] as const;

  const h0 = useReadContract({ abi: conf[0].abi, address: conf[0].contract, functionName: conf[0].fn, args: address ? [address] : undefined, query: { enabled } });
  const h1 = useReadContract({ abi: conf[1].abi, address: conf[1].contract, functionName: conf[1].fn, args: address ? [address] : undefined, query: { enabled } });
  const h2 = useReadContract({ abi: conf[2].abi, address: conf[2].contract, functionName: conf[2].fn, args: address ? [address] : undefined, query: { enabled } });
  const raw = [h0.data, h1.data, h2.data];

  const { data: hasPermit } = useHasPermit({ contractAddresses: [CUSDC, POOL] }, { enabled });
  const { mutate: grantPermit, isPending: granting } = useGrantPermit();

  const inputs = useMemo(
    () =>
      raw
        .map((h, i) => ({ h, c: conf[i]!.contract }))
        .filter((x) => !!x.h && x.h !== ZERO)
        .map((x) => ({ encryptedValue: x.h as `0x${string}`, contractAddress: x.c as string })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [h0.data, h1.data, h2.data],
  );
  const { data: clear, isFetching } = useDecryptValues(inputs, {
    enabled: enabled && hasPermit === true && inputs.length > 0,
  });

  // This screen is the clearest statement of what the product changes, so it was
  // also the worst place to get this wrong: with no wallet connected the PUBLIC
  // rows correctly read `—` while the CONFIDENTIAL ones read `0`, which is
  // exactly backwards and reads as either "the encryption is not real" or "this
  // account is empty". Neither is true; the answer is that it is unknown.
  const show = (h: unknown, decimals: number): string =>
    showConfidential({
      connected: !!address,
      handle: h,
      permitted: hasPermit === true,
      fetching: isFetching,
      clear: h ? clear?.[h as `0x${string}`] : undefined,
      decimals,
    });

  return (
    <div style={css("max-width:900px;width:100%")}>
      <h1 style={css("margin:0;font:800 40px/1.02 var(--display);letter-spacing:-.03em")}>Balances</h1>
      <p style={css("margin:9px 0 0;font:400 16px var(--display);color:var(--ink-2);max-width:70ch")}>
        Two of these are readable by anyone with an RPC endpoint. The rest are not.
      </p>
      <div style={css("height:1px;background:var(--line);margin:22px 0 26px")} />

      <div style={css("background:var(--surface);border:1px solid var(--line);border-radius:20px;padding:6px 22px")}>
        <div style={css("padding:16px 0 10px")}>
          <span style={css("font:650 10.5px var(--display);letter-spacing:.08em;text-transform:uppercase;color:var(--amber)")}>Public</span>
        </div>
        <div style={css("display:flex;align-items:center;justify-content:space-between;padding:13px 0;border-top:1px solid var(--line)")}>
          <span style={css("display:inline-flex;align-items:center;gap:10px;font:600 13.5px var(--display)")}>
            <TokenIcon token="ETH" size={26} />Sepolia ETH <span style={css("font:400 12px var(--display);color:var(--ink-3)")}>· gas</span>
          </span>
          <span style={css("font:700 15px var(--display);font-variant-numeric:tabular-nums")}>
            {!address ? "—" : eth === undefined ? "…" : Number(eth.formatted).toFixed(4)}
          </span>
        </div>
        <div style={css("display:flex;align-items:center;justify-content:space-between;padding:13px 0;border-top:1px solid var(--line)")}>
          <span style={css("display:inline-flex;align-items:center;gap:10px;font:600 13.5px var(--display)")}>
            <TokenIcon token="USDC" size={26} />USDC <span style={css("font:400 12px var(--display);color:var(--ink-3)")}>· before wrapping</span>
          </span>
          <span style={css("font:700 15px var(--display);font-variant-numeric:tabular-nums")}>
            {showPublic(!!address, usdc)}
          </span>
        </div>

        <div style={css("padding:22px 0 10px")}>
          <span style={css("font:650 10.5px var(--display);letter-spacing:.08em;text-transform:uppercase;color:var(--green)")}>Confidential</span>
        </div>
        {conf.map((c, i) => (
          <div key={c.label} style={css("display:flex;align-items:center;justify-content:space-between;gap:16px;padding:13px 0;border-top:1px solid var(--line)")}>
            <span style={css("display:inline-flex;align-items:center;gap:10px;min-width:0")}>
              <TokenIcon token={c.token} size={26} />
              <span style={css("min-width:0")}>
                <span style={css("display:block;font:600 13.5px var(--display)")}>{c.label}</span>
                <span style={css("display:block;font:400 11.5px var(--display);color:var(--ink-3)")}>{c.sub}</span>
              </span>
            </span>
            <span style={css("font:700 15px var(--mono);font-variant-numeric:tabular-nums;white-space:nowrap")}>
              {show(raw[i], c.decimals)}
            </span>
          </div>
        ))}

        <div style={css("padding:18px 0 20px;border-top:1px solid var(--line);margin-top:6px")}>
          {hasPermit !== true ? (
            <>
              <button
                onClick={() => grantPermit([CUSDC, POOL])}
                disabled={granting || !onSepolia || !address}
                style={css("padding:11px 18px;border-radius:12px;border:1px solid rgba(0,0,0,.06);background:linear-gradient(180deg,#ffdf5c,#ffd208);font:700 13px var(--display);color:#1a1a1a;cursor:pointer")}
              >
                {granting ? "Waiting for signature…" : "Decrypt everything"}
              </button>
              <p style={css("margin:11px 0 0;font:400 12px/1.5 var(--display);color:var(--ink-3)")}>
                One EIP-712 signature, kept in this browser. It authorises <i>you</i> to read your own
                balances — it is not a key, and no server ever sees it.
              </p>
            </>
          ) : (
            <p style={css("margin:0;font:400 12px/1.5 var(--display);color:var(--ink-3)")}>
              Decrypted locally. Nobody else can do this — not the pool, not the keeper, not another
              depositor.{" "}
              <a href={`${EXPLORER}/address/${VAULT_SHARE}`} target="_blank" rel="noreferrer" style={css("color:var(--ink-2)")}>
                Vault shares live at {shortAddr(VAULT_SHARE)}
              </a>
              .
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

export default BalancesScreen;

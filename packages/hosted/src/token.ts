/**
 * The bearer token IS the session record.
 *
 * The first version kept sealed keys in a file and handed out a random token
 * that indexed them. That works and it is fragile in exactly the way that
 * matters for a submission: the store lives on one machine, a restart that
 * regenerates the master key silently invalidates every URL a user has pasted
 * into a chat client, and moving the server anywhere means moving a file full of
 * private keys.
 *
 * So there is no store. The token is an AES-256-GCM sealed record containing the
 * session key itself, and any process holding the same master key can serve it.
 * Restart the server, move it to another host, run three of them behind a load
 * balancer — the URLs a user already has keep working.
 *
 * WHAT THIS DOES NOT WEAKEN. The token was always a credential: whoever holds it
 * can spend up to the remaining budget, to the allowlisted addresses, until the
 * owner revokes. That was true when it was a random string indexing a file and it
 * is true now. What changes is only where the key sits at rest.
 *
 * WHAT IT STRENGTHENS. With no server-side record there is nothing to mark
 * closed, so every request has to ask the chain whether the session is still
 * live. Revocation therefore takes effect immediately and without the server
 * being told — which is what the owner was promised, and previously depended on
 * a `forget` call nobody was obliged to make.
 *
 * Layout, packed rather than JSON because a person pastes this into a settings
 * field and 146 characters is kinder than 310:
 *
 *   1   version
 *   32  session key, raw
 *   20  owner
 *   6   expiry, uint48 big-endian
 *   1   read scope
 *   1   token count
 *   20n token addresses
 */
import * as crypto from "node:crypto";
import { getAddress } from "ethers";

const VERSION = 1;

export interface SessionToken {
  readonly privateKey: string;
  readonly ownerAddress: string;
  readonly expiry: number;
  readonly readScope: "spend-only" | "balance-visible";
  readonly tokens: readonly string[];
}

export class TokenSealer {
  private constructor(private readonly key: Buffer) {}

  /**
   * The master key, and a deliberate refusal to invent one.
   *
   * A generated-on-first-run key is what made the old design fragile: it is
   * different on every host and after every wiped disk, and the failure mode is
   * a URL that silently stops working. In production this must be set, and the
   * error says how to make one rather than making one silently.
   */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): TokenSealer {
    const raw = env["GHOSTPOOL_MASTER_KEY"];
    if (raw === undefined || raw === "") {
      throw new Error(
        "GHOSTPOOL_MASTER_KEY is not set. Sessions are sealed under it, so a server " +
          "without one would hand out URLs that stop working the moment it restarts. " +
          "Generate one with:  node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
      );
    }
    if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
      throw new Error("GHOSTPOOL_MASTER_KEY must be 64 hex characters (32 bytes)");
    }
    return new TokenSealer(Buffer.from(raw, "hex"));
  }

  /** For tests, and for nothing else. */
  static forTesting(): TokenSealer {
    return new TokenSealer(crypto.randomBytes(32));
  }

  seal(session: SessionToken): string {
    const tokens = session.tokens.map((t) => Buffer.from(getAddress(t).slice(2), "hex"));
    if (tokens.length > 255) throw new Error("too many tokens for one session");

    const body = Buffer.concat([
      Buffer.from([VERSION]),
      Buffer.from(session.privateKey.replace(/^0x/, ""), "hex"),
      Buffer.from(getAddress(session.ownerAddress).slice(2), "hex"),
      (() => {
        const e = Buffer.alloc(6);
        e.writeUIntBE(session.expiry, 0, 6);
        return e;
      })(),
      Buffer.from([session.readScope === "balance-visible" ? 1 : 0]),
      Buffer.from([tokens.length]),
      ...tokens,
    ]);

    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    const sealed = Buffer.concat([cipher.update(body), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString("base64url");
  }

  /**
   * Opens a token, or explains why it will not.
   *
   * A tampered token fails the GCM tag rather than producing a plausible-looking
   * session, which is the reason for an authenticated cipher here: without the
   * tag, flipping bits in the ciphertext would yield a different private key and
   * the server would happily try to use it.
   */
  open(token: string): SessionToken {
    let buf: Buffer;
    try {
      buf = Buffer.from(token, "base64url");
    } catch {
      throw new Error("that is not a session token");
    }
    if (buf.length < 12 + 16 + 61) throw new Error("that session token is too short to be one");

    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);

    let body: Buffer;
    try {
      body = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]);
    } catch {
      throw new Error(
        "that session token was not issued by this server, or has been altered",
      );
    }

    const version = body.readUInt8(0);
    if (version !== VERSION) throw new Error(`unknown session token version ${version}`);

    const privateKey = `0x${body.subarray(1, 33).toString("hex")}`;
    const ownerAddress = getAddress(`0x${body.subarray(33, 53).toString("hex")}`);
    const expiry = body.readUIntBE(53, 6);
    const readScope = body.readUInt8(59) === 1 ? "balance-visible" : "spend-only";
    const count = body.readUInt8(60);

    const tokens: string[] = [];
    for (let i = 0; i < count; i++) {
      const at = 61 + i * 20;
      if (at + 20 > body.length) throw new Error("session token is truncated");
      tokens.push(getAddress(`0x${body.subarray(at, at + 20).toString("hex")}`));
    }

    return { privateKey, ownerAddress, expiry, readScope, tokens };
  }
}

import { randomBytes } from "node:crypto";
import { isAddress, verifyMessage } from "viem";

export const OPERATOR_AUTH_VERSION = "villa-operator-auth-v1";

export class OperatorAuthError extends Error {
  constructor(code, message, status = 401) {
    super(message);
    this.name = "OperatorAuthError";
    this.code = code;
    this.status = status;
  }
}

function addressKey(address) {
  if (!isAddress(address)) throw new OperatorAuthError("ADDRESS_INVALID", "Connect a valid wallet address.", 400);
  return String(address).toLowerCase();
}

function nonceValue() {
  return randomBytes(18).toString("hex");
}

function sessionValue() {
  return randomBytes(32).toString("base64url");
}

export function createOperatorAuth({
  authorizedAddress,
  allowAnyAddress = false,
  now = () => Date.now(),
  nonceTtlMs = 5 * 60 * 1000,
  sessionTtlMs = 15 * 60 * 1000,
} = {}) {
  const authorized = allowAnyAddress ? null : addressKey(authorizedAddress);
  const nonces = new Map();
  const sessions = new Map();

  function purge() {
    const timestamp = now();
    for (const [key, entry] of nonces) if (entry.expiresAt <= timestamp) nonces.delete(key);
    for (const [key, entry] of sessions) if (entry.expiresAt <= timestamp) sessions.delete(key);
  }

  function messageFor({ address, nonce, expiresAt }) {
    return [
      allowAnyAddress ? "VILLA account sign-in" : "VILLA operator sign-in",
      `Wallet: ${address}`,
      `Nonce: ${nonce}`,
      `Expires: ${new Date(expiresAt).toISOString()}`,
      "This is a message signature only. It sends no blockchain transaction.",
    ].join("\n");
  }

  function issueNonce(address) {
    purge();
    const key = addressKey(address);
    const expiresAt = now() + nonceTtlMs;
    const nonce = nonceValue();
    const message = messageFor({ address, nonce, expiresAt });
    nonces.set(key, { address, nonce, message, expiresAt, verifying: false, used: false });
    return { version: OPERATOR_AUTH_VERSION, address, nonce, message, expiresAt };
  }

  async function verify({ address, nonce, message, signature } = {}) {
    purge();
    const key = addressKey(address);
    if (authorized && key !== authorized) throw new OperatorAuthError("OPERATOR_UNAUTHORIZED", "This wallet is not the authorized VILLA operator wallet.");
    const entry = nonces.get(key);
    if (!entry || entry.nonce !== nonce || entry.message !== message) {
      throw new OperatorAuthError("NONCE_INVALID", "The sign-in request is missing, expired, or already used.");
    }
    if (entry.used || entry.verifying || entry.expiresAt <= now()) {
      throw new OperatorAuthError("NONCE_INVALID", "The sign-in request is missing, expired, or already used.");
    }
    if (typeof signature !== "string" || !signature.startsWith("0x")) {
      throw new OperatorAuthError("SIGNATURE_INVALID", "The wallet returned an invalid signature.", 400);
    }
    entry.verifying = true;
    try {
      const valid = await verifyMessage({ address, message, signature });
      if (!valid) throw new OperatorAuthError("SIGNATURE_INVALID", "The wallet signature did not verify.", 401);
      entry.used = true;
      const issuedAt = now();
      const expiresAt = issuedAt + sessionTtlMs;
      const token = sessionValue();
      sessions.set(token, { address, issuedAt, expiresAt });
      return { version: OPERATOR_AUTH_VERSION, token, operatorAddress: authorized ? address : null, accountAddress: allowAnyAddress ? address : null, issuedAt, expiresAt };
    } catch (error) {
      if (error instanceof OperatorAuthError) throw error;
      throw new OperatorAuthError("SIGNATURE_INVALID", "The wallet signature did not verify.", 401);
    } finally {
      entry.verifying = false;
    }
  }

  function authenticate(token) {
    purge();
    if (typeof token !== "string" || token.length < 20) return null;
    const session = sessions.get(token);
    if (!session || session.expiresAt <= now()) {
      sessions.delete(token);
      return null;
    }
    return { ...session };
  }

  function revoke(token) {
    sessions.delete(token);
  }

  return Object.freeze({ issueNonce, verify, authenticate, revoke, messageFor });
}

export function bearerToken(request) {
  const header = request.headers?.authorization ?? request.headers?.Authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(String(header));
  return match ? match[1].trim() : null;
}

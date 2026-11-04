import { randomBytes } from "node:crypto";

import { getAddress, isAddress, recoverMessageAddress } from "viem";

import { consumeChallenge, createSession, getChallenge, putChallenge, revokeSession, sessionOwner, takeRateLimit } from "@/server/database";

const CHAIN_ID = 10_143;
const CHALLENGE_TTL_MS = 5 * 60 * 1_000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1_000;
export const SESSION_COOKIE = "donads_session";

export function normalizeAddress(value: string): string {
  if (!isAddress(value)) throw new Error("A valid EVM wallet address is required.");
  return getAddress(value).toLowerCase();
}

function requestIdentity(request: Request): { domain: string; uri: string } {
  const url = new URL(request.url);
  const forwardedHost = request.headers.get("x-forwarded-host");
  const domain = forwardedHost ?? request.headers.get("host") ?? url.host;
  const protocol = request.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "") ?? "https";
  return { domain, uri: `${protocol}://${domain}` };
}

export async function createChallenge(request: Request, rawAddress: string) {
  const address = normalizeAddress(rawAddress);
  const client = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (!await takeRateLimit(`challenge:${client}:${address}`, 10, 10 * 60 * 1_000)) throw new Error("Too many sign-in attempts. Try again in ten minutes.");
  const { domain, uri } = requestIdentity(request);
  const nonce = randomBytes(12).toString("hex");
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + CHALLENGE_TTL_MS);
  const message = `${domain} wants you to sign in with your Ethereum account:\n${address}\n\nSign in to DONADS. This signature cannot move funds.\n\nURI: ${uri}\nVersion: 1\nChain ID: ${CHAIN_ID}\nNonce: ${nonce}\nIssued At: ${issuedAt.toISOString()}\nExpiration Time: ${expiresAt.toISOString()}`;
  await putChallenge(address, message, expiresAt.getTime());
  return { message };
}

export async function verifyChallenge(rawAddress: string, signature: `0x${string}`) {
  const address = normalizeAddress(rawAddress);
  const challenge = await getChallenge(address);
  if (!challenge) throw new Error("The sign-in challenge is invalid, expired, or already used.");
  const recovered = await recoverMessageAddress({ message: challenge.message, signature });
  if (normalizeAddress(recovered) !== address) throw new Error("The wallet signature does not match the requested address.");
  if (!await consumeChallenge(address, challenge.message)) throw new Error("The sign-in challenge was already used.");
  const token = randomBytes(32).toString("base64url");
  const expiresAtMs = Date.now() + SESSION_TTL_MS;
  await createSession(token, address, expiresAtMs);
  return { access_token: token, owner_id: address, expires_at: new Date(expiresAtMs).toISOString() };
}

function cookieToken(request: Request): string | null {
  const cookies = request.headers.get("cookie") ?? "";
  for (const part of cookies.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === SESSION_COOKIE) return decodeURIComponent(value.join("="));
  }
  return null;
}

export function sessionToken(request: Request): string | null {
  const value = request.headers.get("authorization");
  return value?.startsWith("Bearer ") ? value.slice(7).trim() : cookieToken(request);
}

export async function authenticate(request: Request): Promise<{ ownerId: string; token: string }> {
  const token = sessionToken(request);
  if (!token) throw new Error("AUTH_REQUIRED");
  const ownerId = await sessionOwner(token);
  if (!ownerId) throw new Error("AUTH_REQUIRED");
  if (!await takeRateLimit(`session:${token}`, 180, 60 * 1_000)) throw new Error("Too many requests. Try again in one minute.");
  return { ownerId, token };
}

export async function logout(request: Request): Promise<void> {
  const token = sessionToken(request);
  if (token) await revokeSession(token);
}

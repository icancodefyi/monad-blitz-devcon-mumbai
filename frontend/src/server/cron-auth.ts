import { timingSafeEqual } from "node:crypto";

/** Cron endpoints require `Authorization: Bearer <CRON_SECRET>` (32+ characters). */
export function cronAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  const header = request.headers.get("authorization") ?? "";
  if (!secret || secret.length < 32 || !header.startsWith("Bearer ")) return false;
  const left = Buffer.from(header.slice(7)); const right = Buffer.from(secret);
  return left.length === right.length && timingSafeEqual(left, right);
}

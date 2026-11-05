import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { db } from "./db";
import type { User } from "../lib/types";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
export function passwordHash(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}
export function passwordMatches(password: string, stored: string) {
  const [salt, digest] = stored.split(":");
  if (!salt || !digest) return false;
  const expected = Buffer.from(digest, "hex");
  const actual = scryptSync(password, salt, 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export function demoLoginEnabled() {
  return (
    process.env.APP_MODE === "demo" &&
    process.env.ENABLE_DEMO_LOGIN === "true" &&
    process.env.NODE_ENV !== "production"
  );
}
export async function userForRequest(request: Request): Promise<User | null> {
  const token = request.headers
    .get("cookie")
    ?.split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith("linkd_session="))
    ?.slice(14);
  if (!token) return null;
  return (
    (
      await db.query(
        `SELECT u.id,u.name,u.email,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active=true`,
        [hash(token)],
      )
    ).rows[0] ?? null
  );
}
export async function requireUser(request: Request) {
  const user = await userForRequest(request);
  if (!user) throw new HttpError(401, "Please sign in to continue.");
  return user;
}
export function requireRole(user: User, roles: User["role"][]) {
  if (!roles.includes(user.role))
    throw new HttpError(403, "Your role does not allow this action.");
}
export function checkOrigin(request: Request) {
  const configured = new URL(process.env.APP_URL || "http://localhost:3000");
  if (process.env.NODE_ENV === "production" && configured.protocol !== "https:")
    throw new HttpError(503, "Production requires an HTTPS APP_URL.");
  if (request.headers.get("origin") !== configured.origin)
    throw new HttpError(403, "Request origin is not allowed.");
}
export async function createSession(userId: string) {
  const token = randomBytes(32).toString("hex");
  await db.query(
    "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES ($1,$2,now()+interval '7 days')",
    [hash(token), userId],
  );
  return `linkd_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
}
export async function login(request: Request, email: string, password: string) {
  const key = hash(email.toLowerCase());
  const count = Number(
    (
      await db.query(
        "SELECT count(*) FROM login_attempts WHERE key=$1 AND created_at>now()-interval '15 minutes'",
        [key],
      )
    ).rows[0].count,
  );
  if (count >= 10)
    throw new HttpError(429, "Too many attempts. Try again in 15 minutes.");
  const user = (
    await db.query("SELECT * FROM users WHERE lower(email)=$1", [
      email.toLowerCase(),
    ])
  ).rows[0];
  if (
    !user?.active ||
    !user?.password_hash ||
    !passwordMatches(password, user.password_hash)
  ) {
    await db.query("INSERT INTO login_attempts(key) VALUES ($1)", [key]);
    throw new HttpError(401, "Email or password is incorrect.");
  }
  await db.query("DELETE FROM login_attempts WHERE key=$1", [key]);
  return createSession(user.id);
}

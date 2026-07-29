import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import crypto from "node:crypto";
import { prisma } from "../lib/prisma.js";

/**
 * Cookie-session auth, zero extra deps.
 *   - scrypt password hashes ("scrypt:salt:hash")
 *   - signed session cookie  "userId.expiresMs.hmac"
 *   - SETUP MODE: while no users exist the API is open (local bootstrap);
 *     the UI offers "create your login" and enforcement starts at first user.
 */

const COOKIE = "abw_session";
const key = () => crypto.createHash("sha256").update(process.env.ABW_SECRET_KEY ?? "abw-dev-secret").digest();

export function hashPassword(pw: string) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(pw, salt, 32).toString("hex");
  return `scrypt:${salt}:${hash}`;
}
export function verifyPassword(pw: string, stored: string) {
  const [scheme, salt, hash] = stored.split(":");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const check = crypto.scryptSync(pw, salt, 32).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(check, "hex"), Buffer.from(hash, "hex"));
}

function sign(payload: string) {
  return crypto.createHmac("sha256", key()).update(payload).digest("hex").slice(0, 32);
}
function makeSession(userId: string, days = 30) {
  const exp = Date.now() + days * 24 * 3600e3;
  const payload = `${userId}.${exp}`;
  return `${payload}.${sign(payload)}`;
}
export function parseSession(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  const m = cookieHeader.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return null;
  const [userId, exp, sig] = decodeURIComponent(m[1]!).split(".");
  if (!userId || !exp || !sig) return null;
  if (sign(`${userId}.${exp}`) !== sig) return null;
  if (Number(exp) < Date.now()) return null;
  return userId;
}

// cached user count so the auth hook doesn't hit the DB on every request
let userCountCache = { n: -1, at: 0 };
export async function userCount() {
  if (Date.now() - userCountCache.at > 30_000 || userCountCache.n < 0) {
    userCountCache = { n: await prisma.user.count(), at: Date.now() };
  }
  return userCountCache.n;
}
export function bustUserCountCache() { userCountCache = { n: -1, at: 0 }; }

export async function currentUser(req: FastifyRequest) {
  const userId = parseSession(req.headers.cookie);
  if (!userId) return null;
  return prisma.user.findUnique({ where: { id: userId } });
}

const cookieAttrs = "Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000";

export async function authRoutes(app: FastifyInstance) {
  const Register = z.object({
    email: z.string().email(),
    name: z.string().min(1),
    password: z.string().min(8),
    role: z.enum(["admin", "viewer"]).default("admin"),
  });
  // First user: open (setup). After that: admins only.
  app.post("/auth/register", async (req, reply) => {
    const input = Register.parse(req.body);
    const count = await userCount();
    if (count > 0) {
      const me = await currentUser(req);
      if (!me || me.role !== "admin") return reply.code(403).send({ error: "only admins can add users" });
    }
    const user = await prisma.user.create({
      data: {
        email: input.email.toLowerCase(),
        name: input.name,
        passwordHash: hashPassword(input.password),
        role: count === 0 ? "admin" : input.role,
      },
    });
    bustUserCountCache();
    reply.header("set-cookie", `${COOKIE}=${encodeURIComponent(makeSession(user.id))}; ${cookieAttrs}`);
    return { ok: true, user: { id: user.id, email: user.email, name: user.name, role: user.role } };
  });

  const Login = z.object({ email: z.string().email(), password: z.string().min(1) });
  app.post("/auth/login", async (req, reply) => {
    const input = Login.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: input.email.toLowerCase() } });
    if (!user || !verifyPassword(input.password, user.passwordHash)) {
      return reply.code(401).send({ error: "invalid email or password" });
    }
    reply.header("set-cookie", `${COOKIE}=${encodeURIComponent(makeSession(user.id))}; ${cookieAttrs}`);
    return { ok: true, user: { id: user.id, email: user.email, name: user.name, role: user.role } };
  });

  app.post("/auth/logout", async (_req, reply) => {
    reply.header("set-cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    return { ok: true };
  });

  app.get("/auth/me", async (req, reply) => {
    if ((await userCount()) === 0) return { setup: true, user: null };
    const user = await currentUser(req);
    if (!user) return reply.code(401).send({ error: "not signed in" });
    return { setup: false, user: { id: user.id, email: user.email, name: user.name, role: user.role } };
  });

  app.get("/auth/users", async (req, reply) => {
    const me = await currentUser(req);
    if (!me || me.role !== "admin") return reply.code(403).send({ error: "admins only" });
    return prisma.user.findMany({ select: { id: true, email: true, name: true, role: true, createdAt: true } });
  });
}

/**
 * Enforcement hook (registered in server.ts):
 *  - open while no users exist (setup mode)
 *  - /api/health and /api/auth/* always reachable
 *  - viewers: read-only (GET/HEAD)
 */
export async function requireAuth(req: FastifyRequest): Promise<{ code: number; error: string } | null> {
  const url = req.url.split("?")[0] ?? "";
  if (url === "/api/health" || url.startsWith("/api/auth/")) return null;
  if ((await userCount()) === 0) return null; // setup mode
  const user = await currentUser(req);
  if (!user) return { code: 401, error: "sign in required" };
  if (user.role === "viewer" && !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    return { code: 403, error: "viewer accounts are read-only" };
  }
  return null;
}

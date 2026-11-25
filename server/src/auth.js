import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { db, newId, now, sha256 } from "./db.js";

const COOKIE = "attest_session";
const SESSION_DAYS = 14;

export function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(String(password), salt, 32).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored || "").split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const next = scryptSync(String(password), salt, 32);
  const prev = Buffer.from(hash, "hex");
  if (next.length !== prev.length) return false;
  return timingSafeEqual(next, prev);
}

export function ensureAdminPassword() {
  const user = db
    .prepare("SELECT * FROM users WHERE role = 'admin' AND is_active = 1 ORDER BY created_at LIMIT 1")
    .get();
  if (!user || user.password_hash) return null;
  const password = process.env.ATTEST_ADMIN_PASSWORD || randomBytes(9).toString("base64url");
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(password), user.id);
  const file = path.resolve("data/initial-admin.txt");
  writeFileSync(file, `${user.email}\n${password}\n`);
  console.log(`Staff login ready for ${user.email}. Password is in server/data/initial-admin.txt`);
  return { email: user.email };
}

function readCookie(req, name) {
  const raw = String(req.headers.cookie || "");
  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}

export function userFromRequest(req) {
  const raw = readCookie(req, COOKIE);
  if (!raw) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.email, u.name, u.role
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ? AND u.is_active = 1`
    )
    .get(sha256(raw), now());
  return row || null;
}

export function login(email, password) {
  const user = db
    .prepare("SELECT * FROM users WHERE lower(email) = lower(?) AND is_active = 1")
    .get(String(email || "").trim());
  if (!user || !verifyPassword(password, user.password_hash)) {
    throw new Error("Email or password is wrong");
  }
  const raw = randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  db.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(newId(), user.id, sha256(raw), expires, now());
  return {
    token: raw,
    cookie: `${COOKIE}=${raw}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}`,
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
  };
}

export function logout(req) {
  const raw = readCookie(req, COOKIE);
  if (raw) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(raw));
  return `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

export function isPublicApi(req) {
  const pathName = req.path || "";
  if (req.method === "POST" && pathName === "/api/auth/login") return true;
  if (pathName === "/api/health") return true;
  if (pathName.startsWith("/api/sign/")) return true;
  if (pathName.startsWith("/api/diligence/")) return true;
  if (req.method === "GET" && /^\/api\/envelopes\/[^/]+\/documents\//.test(pathName)) return true;
  if (req.method === "GET" && /^\/api\/envelopes\/[^/]+\/due-diligence$/.test(pathName)) return true;
  return false;
}

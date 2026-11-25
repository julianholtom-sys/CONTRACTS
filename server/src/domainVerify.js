import { randomBytes, randomInt } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { db, now, sha256, newId } from "./db.js";
import { deliverMail } from "./smtp.js";

export function normalizeDomain(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^www\./, "");
}

export function fromMatchesDomain(fromAddress, sendingDomain) {
  const domain = normalizeDomain(sendingDomain);
  const email = String(fromAddress || "").trim().toLowerCase();
  const at = email.lastIndexOf("@");
  if (at < 0 || !domain) return false;
  return email.slice(at + 1) === domain;
}

export function dnsHost(sendingDomain) {
  return `_attest.${normalizeDomain(sendingDomain)}`;
}

export function dnsTxtValue(token) {
  return `attest-domain-verify=${token}`;
}

function lookupTxt(host, ms = 8000) {
  const resolver = new Resolver();
  resolver.setServers(["8.8.8.8", "1.1.1.1"]);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(`timed out after ${ms / 1000}s`);
      err.code = "ETIMEOUT";
      reject(err);
    }, ms);
    resolver.resolveTxt(host).then(
      (records) => {
        clearTimeout(timer);
        resolve(records);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

export function ensureVerifyToken(entityId) {
  const entity = db.prepare("SELECT * FROM entities WHERE id = ?").get(entityId);
  if (!entity) return null;
  if (entity.domain_verify_token) return entity.domain_verify_token;
  const token = randomBytes(16).toString("hex");
  db.prepare("UPDATE entities SET domain_verify_token = ? WHERE id = ?").run(token, entityId);
  return token;
}

export function clearVerification(entityId) {
  db.prepare(
    `UPDATE entities SET
      domain_verified = 0,
      domain_verified_at = NULL,
      domain_verify_code_hash = NULL,
      domain_verify_code_expires = NULL
     WHERE id = ?`
  ).run(entityId);
}

function markVerified(entityId) {
  db.prepare(
    `UPDATE entities SET
      domain_verified = 1,
      domain_verified_at = ?,
      domain_verify_code_hash = NULL,
      domain_verify_code_expires = NULL
     WHERE id = ?`
  ).run(now(), entityId);
}

export async function verifyDns(entityId) {
  const entity = db.prepare("SELECT * FROM entities WHERE id = ?").get(entityId);
  if (!entity) throw new Error("Not found");
  if (!fromMatchesDomain(entity.from_address, entity.sending_domain)) {
    throw new Error("From address must use the sending domain before it can be verified");
  }
  const token = ensureVerifyToken(entityId);
  const host = dnsHost(entity.sending_domain);
  const expected = dnsTxtValue(token);
  let records = [];
  try {
    records = await lookupTxt(host);
  } catch (err) {
    throw new Error(
      `No matching TXT yet on ${host} (${err.code || err.message}). Add the record below, wait for DNS, then try again — or send a code to the from address.`
    );
  }
  const values = records.map((parts) => parts.join(""));
  if (!values.some((value) => value.trim() === expected)) {
    throw new Error(`TXT record on ${host} does not match yet`);
  }
  markVerified(entityId);
  return serializeDomainVerify(db.prepare("SELECT * FROM entities WHERE id = ?").get(entityId));
}

export async function sendVerifyCode(entityId) {
  const entity = db.prepare("SELECT * FROM entities WHERE id = ?").get(entityId);
  if (!entity) throw new Error("Not found");
  if (!fromMatchesDomain(entity.from_address, entity.sending_domain)) {
    throw new Error("From address must use the sending domain before it can be verified");
  }
  ensureVerifyToken(entityId);
  const code = String(randomInt(100000, 1000000));
  const expires = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  db.prepare(
    `UPDATE entities SET domain_verify_code_hash = ?, domain_verify_code_expires = ? WHERE id = ?`
  ).run(sha256(code), expires, entityId);

  const subject = `Verify sending address for ${entity.display_name}`;
  const bodyText = `Your Attest domain verification code is ${code}. It expires in 30 minutes.`;
  const bodyHtml = `<p>Your Attest domain verification code is <strong>${code}</strong>.</p><p>It expires in 30 minutes.</p>`;
  const id = newId();
  db.prepare(
    `INSERT INTO outbound_emails (
      id, envelope_id, party_id, template_type, to_address,
      subject, body_html, body_text, content_hash, created_at
    ) VALUES (?, NULL, NULL, 'domain_verify', ?, ?, ?, ?, ?, ?)`
  ).run(id, entity.from_address, subject, bodyHtml, bodyText, sha256(`${subject}\n${bodyText}`), now());
  const delivery = await deliverMail({
    entity,
    to: entity.from_address,
    subject,
    text: bodyText,
    html: bodyHtml,
    allowOutlook: true,
  });
  console.log(`[mail:domain_verify] to=${entity.from_address} via=${delivery.via} subject=${subject}`);
  return {
    sent: true,
    to: entity.from_address,
    via: delivery.via,
    expires_at: expires,
  };
}

export function confirmVerifyCode(entityId, code) {
  const entity = db.prepare("SELECT * FROM entities WHERE id = ?").get(entityId);
  if (!entity) throw new Error("Not found");
  if (!entity.domain_verify_code_hash) {
    throw new Error("No verification code has been sent");
  }
  if (new Date(entity.domain_verify_code_expires).getTime() < Date.now()) {
    throw new Error("That code has expired. Send a new one.");
  }
  if (sha256(String(code || "").trim()) !== entity.domain_verify_code_hash) {
    throw new Error("That code does not match");
  }
  markVerified(entityId);
  return serializeDomainVerify(db.prepare("SELECT * FROM entities WHERE id = ?").get(entityId));
}

export function latestVerifyEmail(entityId) {
  return db
    .prepare(
      `SELECT to_address, subject, created_at
       FROM outbound_emails
       WHERE template_type = 'domain_verify' AND to_address = (
         SELECT from_address FROM entities WHERE id = ?
       )
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(entityId);
}

export function serializeDomainVerify(entity) {
  if (!entity) return null;
  const token = entity.domain_verify_token || null;
  return {
    domain_verified: Boolean(entity.domain_verified),
    domain_verified_at: entity.domain_verified_at || null,
    from_matches_domain: fromMatchesDomain(entity.from_address, entity.sending_domain),
    dns_host: entity.sending_domain ? dnsHost(entity.sending_domain) : null,
    dns_txt: token ? dnsTxtValue(token) : null,
  };
}

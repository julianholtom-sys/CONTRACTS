import express from "express";
import cors from "cors";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, newId, now, sha256, parseJson } from "./db.js";
import { appendEvent, listEvents, verifyEventChain } from "./events.js";
import {
  bakeEnvelope,
  bakeInSignedPack,
  resolveBrandPack,
  getMasterTemplate,
  listAppendices,
} from "./bake.js";
import {
  CONSENT_TEXT,
  applySignatureAndCompleteParty,
  evidenceChecklist,
  evidenceGateOpen,
  getActionableParty,
  inviteParty,
  issuePartyToken,
  resolveToken,
  startSigningInvites,
} from "./signing.js";
import { ensureSeed, ensureSigningEvidence } from "./seed.js";
import { isPublicApi, login, logout, userFromRequest } from "./auth.js";
import { lookupCompany } from "./companiesHouse.js";
import { readSignatureInput } from "./signatureInput.js";
import {
  contractFromLibrary,
  listDirectory,
  listLibrary,
  saveBrokerSignatory,
  saveLibraryTemplate,
} from "./library.js";
import { SIGN_ORDER } from "./parties.js";
import {
  getPartyRecord,
  listPartyRecords,
  readPartyFile,
  refreshPartyRegistry,
  saveDocChecks,
  savePartyRecord,
  savePartyUpload,
} from "./partyRecords.js";
import {
  addNameChange,
  assertContractMayBeIssued,
  assertDdEditable,
  compileDueDiligence,
  diligenceSession,
  dueDiligenceState,
  readDueDiligence,
  removeNameChange,
  saveDueDiligenceFile,
  setOfficeChanged,
  signDueDiligence,
  submitDueDiligence,
} from "./dueDiligence.js";
import { seedDefaultEmailTemplates, listOutboundEmails } from "./mail.js";
import { readBytes, writeBytes } from "./storage.js";
import { fetchRemoteImageDataUrl, normalizeGmailSignature } from "./gmailSignature.js";
import {
  confirmVerifyCode,
  ensureVerifyToken,
  latestVerifyEmail,
  sendVerifyCode,
  serializeDomainVerify,
  clearVerification,
  verifyDns,
} from "./domainVerify.js";
import { smtpConfig, verifySmtp, deliverMail } from "./smtp.js";
import { getComplianceCompany, publicCompliance, saveComplianceCompany } from "./compliance.js";
import {
  applyAppendixPdfFields,
  applyMasterPdfFields,
  fieldsForParty,
  getSignField,
  listAppendixFields,
} from "./documentFields.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const isProd = process.env.NODE_ENV === "production";
const BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

function assetMime(file) {
  const name = String(file.originalname || "").toLowerCase();
  const mime = String(file.mimetype || "").toLowerCase();
  const head = file.buffer
    ? file.buffer.subarray(0, 256).toString("utf8").trimStart()
    : "";
  if (name.endsWith(".svg") || mime.includes("svg") || /^<svg[\s>]|^<\?xml[\s\S]*<svg[\s>]/i.test(head)) {
    return "image/svg+xml";
  }
  if (mime && mime !== "application/octet-stream") return mime;
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".gif")) return "image/gif";
  if (name.endsWith(".webp")) return "image/webp";
  if (name.endsWith(".pdf")) return "application/pdf";
  if (name.endsWith(".docx")) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  if (name.endsWith(".doc")) return "application/msword";
  return mime || "application/octet-stream";
}

function publicBase(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, "");
  const proto = (req.headers["x-forwarded-proto"] || req.protocol || "http")
    .toString()
    .split(",")[0]
    .trim();
  const host = (req.headers["x-forwarded-host"] || req.headers.host || `localhost:${PORT}`)
    .toString()
    .split(",")[0]
    .trim();
  return `${proto}://${host}`;
}

await ensureSeed();

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "20mb" }));
app.use((req, res, next) => {
  if (!req.path.startsWith("/api")) return next();
  if (isPublicApi(req) || req.path.startsWith("/api/auth/")) return next();
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: "Sign in required" });
  req.user = user;
  next();
});

app.post("/api/auth/login", (req, res) => {
  try {
    const result = login(req.body?.email, req.body?.password);
    res.setHeader("Set-Cookie", result.cookie);
    res.json({ user: result.user });
  } catch (err) {
    res.status(401).json({ error: err.message || "Sign in failed" });
  }
});

app.post("/api/auth/logout", (req, res) => {
  res.setHeader("Set-Cookie", logout(req));
  res.json({ ok: true });
});

app.get("/api/auth/me", (req, res) => {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: "Sign in required" });
  res.json({ user });
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

// IP addresses are not recorded for any party, so nothing downstream receives one.
function clientMeta(req) {
  return {
    ip: null,
    userAgent: req.headers["user-agent"] || "unknown",
  };
}

function brokerDiligenceUrl(envelopeId, baseUrl) {
  const broker = db
    .prepare(
      `SELECT p.id
       FROM envelope_parties p
       JOIN template_roles r ON r.id = p.role_id
       WHERE p.envelope_id = ? AND r.role_key = 'agency'`
    )
    .get(envelopeId);
  if (!broker) throw new Error("This contract has no broker");
  const envelope = db.prepare("SELECT * FROM envelopes WHERE id = ?").get(envelopeId);
  assertDdEditable(envelope);
  const token = issuePartyToken(broker.id);
  return { url: `${baseUrl}/diligence/${token.raw}`, path: `/diligence/${token.raw}` };
}

function fileNameFromRef(ref) {
  const value = String(ref || "").replace(/^local:\/\//, "");
  const parts = value.split(/[/\\]/);
  return parts[parts.length - 1] || "document.pdf";
}

function sendStoredPdf(res, storageRef, filename) {
  const ref = String(storageRef || "").replace(/^local:\/\//, "");
  const bytes = readBytes(ref);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${filename || fileNameFromRef(ref)}"`);
  res.send(bytes);
}

function serializeEntity(row) {
  if (!row) return null;
  const {
    domain_verify_code_hash,
    domain_verify_code_expires,
    smtp_pass,
    ...safe
  } = row;
  return {
    ...safe,
    brand: parseJson(row.brand_json, {}),
    domain_verified: Boolean(row.domain_verified),
    is_active: Boolean(row.is_active),
    smtp_configured: Boolean(smtpConfig(row)),
    outlook_available: process.platform === "win32",
    smtp_provider: row.smtp_provider || null,
    ...serializeDomainVerify(row),
  };
}

function getEnvelopeBundle(id) {
  const envelope = db.prepare("SELECT * FROM envelopes WHERE id = ?").get(id);
  if (!envelope) return null;
  const entity = serializeEntity(
    db.prepare("SELECT * FROM entities WHERE id = ?").get(envelope.entity_id)
  );
  const parties = db
    .prepare(
      `SELECT p.*, r.role_key, r.label AS role_label, r.evidence_required, r.signing_order
       FROM envelope_parties p
       JOIN template_roles r ON r.id = p.role_id
       WHERE p.envelope_id = ?
       ORDER BY p.order_index ASC`
    )
    .all(id)
    .map((p) => ({ ...p, evidence_required: Boolean(p.evidence_required) }));
  const documents = db
    .prepare("SELECT * FROM documents WHERE envelope_id = ? ORDER BY created_at ASC")
    .all(id);
  const events = listEvents(id);
  const emails = listOutboundEmails(id);
  const actionable = getActionableParty(id);
  const template = envelope.template_id
    ? db.prepare("SELECT * FROM templates WHERE id = ?").get(envelope.template_id)
    : null;
  const brand = resolveBrandPack(envelope.entity_id, {
    industry: envelope.industry,
    appendixIds: parseJson(envelope.appendix_ids_json, []),
  });
  const appendixIds = parseJson(envelope.appendix_ids_json, []);
  const appendices = listAppendices({ ids: appendixIds });
  const front = envelope.front_cover_id
    ? db.prepare("SELECT * FROM entity_assets WHERE id = ?").get(envelope.front_cover_id)
    : brand.front;
  const back = envelope.back_cover_id
    ? db.prepare("SELECT * FROM entity_assets WHERE id = ?").get(envelope.back_cover_id)
    : brand.back;
  const logo = envelope.logo_asset_id
    ? db.prepare("SELECT * FROM entity_assets WHERE id = ?").get(envelope.logo_asset_id)
    : brand.logo;
  return {
    ...envelope,
    entity,
    template,
    parties,
    documents,
    events,
    emails,
    actionable_party_id: actionable?.id || null,
    auto_pack: {
      front,
      back,
      logo,
      appendices,
      industry: envelope.industry || brand.industry,
    },
    due_diligence: dueDiligenceState(id),
  };
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "attest",
    storage: "local-disk",
    db: "sqlite",
    model: "esign-data-model-local",
  });
});

app.get("/api/directory", (req, res) => {
  res.json(listDirectory(req.query.kind || null));
});

app.get("/api/parties", (req, res) => {
  try {
    res.json(listPartyRecords(req.query.kind));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/parties/:kind", (req, res) => {
  try {
    res.status(201).json(savePartyRecord(req.params.kind, req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/parties/:id", (req, res) => {
  try {
    res.json(getPartyRecord(req.params.id));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.patch("/api/parties/:id", (req, res) => {
  try {
    const existing = getPartyRecord(req.params.id);
    res.json(savePartyRecord(existing.kind, { ...req.body, id: existing.id }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/companies-house/:number", async (req, res) => {
  try {
    res.json(await lookupCompany(req.params.number));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/parties/:id/registry", async (req, res) => {
  try {
    res.json(await refreshPartyRegistry(req.params.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/parties/:id/files", upload.single("file"), (req, res) => {
  try {
    res.status(201).json(savePartyUpload(req.params.id, req.body?.requirementKey, req.file));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/parties/:id/files/:fileId", (req, res) => {
  const file = readPartyFile(req.params.id, req.params.fileId);
  if (!file) return res.status(404).json({ error: "File not found" });
  res.setHeader("Content-Type", file.mime || "application/octet-stream");
  res.send(readBytes(file.storage_ref));
});

app.post("/api/envelopes/:id/dd/checks", (req, res) => {
  try {
    const envelope = db.prepare("SELECT * FROM envelopes WHERE id = ?").get(req.params.id);
    if (!envelope) return res.status(404).json({ error: "Not found" });
    assertDdEditable(envelope);
    saveDocChecks(req.params.id, req.body?.checks || [], req.user?.name || req.user?.email || "");
    res.json(getEnvelopeBundle(req.params.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/compliance", (_req, res) => {
  res.json(publicCompliance(getComplianceCompany()));
});

app.put("/api/compliance", (req, res) => {
  try {
    res.json(saveComplianceCompany(req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/compliance/mail/test", async (req, res) => {
  try {
    const result = await verifySmtp(getComplianceCompany(), req.body || {});
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/entities/:id/signatory", (req, res) => {
  try {
    res.status(201).json(saveBrokerSignatory(req.params.id, req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/library", (_req, res) => {
  res.json(listLibrary());
});

app.post("/api/library", (req, res) => {
  try {
    res.status(201).json(saveLibraryTemplate(req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message || "Could not save the library template" });
  }
});

app.get("/api/bootstrap", (req, res) => {
  const entities = db
    .prepare("SELECT * FROM entities WHERE is_active = 1 ORDER BY display_name")
    .all()
    .map(serializeEntity);
  const masterTemplate = getMasterTemplate();
  const templates = db
    .prepare("SELECT * FROM templates WHERE is_active = 1 ORDER BY is_master DESC, name")
    .all();
  const users = db.prepare("SELECT id, email, name, role FROM users WHERE is_active = 1").all();
  const appendices = listAppendices().map((a) => ({
    id: a.id,
    entity_id: a.entity_id,
    industry: a.industry,
    name: a.name,
    description: a.description,
    is_active: a.is_active,
  }));
  const assets = db
    .prepare("SELECT id, entity_id, kind, name, mime, page_size, is_active FROM entity_assets WHERE is_active = 1 ORDER BY kind, name")
    .all();
  const industries = [
    ...new Set(appendices.map((a) => a.industry).filter(Boolean)),
  ].sort();
  res.json({
    entities,
    masterTemplate,
    templates,
    users,
    appendices,
    assets,
    industries,
    baseUrl: publicBase(req),
  });
});

app.get("/api/brand-pack", (req, res) => {
  const entityId = req.query.entityId;
  const industry = req.query.industry || null;
  const appendixIds = String(req.query.appendixIds || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!entityId) {
    return res.status(400).json({ error: "entityId required" });
  }
  const pack = resolveBrandPack(entityId, {
    industry,
    appendixIds: appendixIds.length ? appendixIds : [],
  });
  const available = industry ? listAppendices({ industry, entityId }) : [];
  res.json({
    industry: pack.industry,
    front: pack.front
      ? { id: pack.front.id, name: pack.front.name, kind: pack.front.kind }
      : null,
    back: pack.back
      ? { id: pack.back.id, name: pack.back.name, kind: pack.back.kind }
      : null,
    logo: pack.logo
      ? { id: pack.logo.id, name: pack.logo.name, kind: pack.logo.kind }
      : null,
    appendices: pack.appendices.map((a) => ({
      id: a.id,
      name: a.name,
      industry: a.industry,
      description: a.description,
    })),
    availableAppendices: available.map((a) => ({
      id: a.id,
      name: a.name,
      industry: a.industry,
      description: a.description,
    })),
  });
});

app.get("/api/entities", (_req, res) => {
  res.json(
    db
      .prepare("SELECT * FROM entities WHERE is_active = 1 ORDER BY display_name")
      .all()
      .map(serializeEntity)
  );
});

app.get("/api/entities/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM entities WHERE id = ? AND is_active = 1").get(req.params.id);
  const entity = serializeEntity(row);
  if (!entity) return res.status(404).json({ error: "Not found" });
  const assets = db
    .prepare(
      "SELECT * FROM entity_assets WHERE entity_id = ? ORDER BY kind, created_at DESC"
    )
    .all(entity.id);
  const pack = resolveBrandPack(entity.id, { industry: null });
  const signatureAsset = db
    .prepare(
      `SELECT id, name, mime, kind FROM entity_assets
       WHERE entity_id = ? AND kind = 'email_header' AND is_active = 1
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(entity.id);
  if (!entity.domain_verify_token) ensureVerifyToken(entity.id);
  const fresh = db.prepare("SELECT * FROM entities WHERE id = ?").get(entity.id);
  res.json({
    ...serializeEntity(fresh),
    assets,
    signature_asset: signatureAsset || null,
    active_pack: {
      front: pack.front,
      back: pack.back,
      logo: pack.logo,
    },
    verify_email: latestVerifyEmail(entity.id) || null,
  });
});

app.post("/api/entities", (req, res) => {
  try {
    const body = req.body || {};
    const required = [
      "slug",
      "legal_name",
      "company_number",
      "registered_office",
      "display_name",
    ];
    for (const key of required) {
      if (!body[key]) return res.status(400).json({ error: `${key} required` });
    }
    if (db.prepare("SELECT id FROM entities WHERE slug = ?").get(body.slug)) {
      return res.status(400).json({ error: "slug already exists" });
    }
    const id = newId();
    const signature = normalizeGmailSignature(
      body.email_signature_html || `<p>Kind regards,<br/>${body.display_name}</p>`,
      body.email_signature_text || `Kind regards,\n${body.display_name}`
    );
    db.prepare(
      `INSERT INTO entities (
        id, slug, legal_name, company_number, vat_number, registered_office,
        display_name, brand_json, sending_domain, from_address, reply_to,
        email_signature_html, email_signature_text, intro_email_text, domain_verified, is_active, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
    ).run(
      id,
      body.slug,
      body.legal_name,
      body.company_number,
      body.vat_number || null,
      body.registered_office,
      body.display_name,
      JSON.stringify(
        body.brand || {
          primary: "#0074ff",
          secondary: "#101828",
          logo_asset_id: null,
          font: "Manrope",
        }
      ),
      body.sending_domain || "",
      body.from_address || "",
      body.reply_to || null,
      signature.html,
      signature.text,
      body.intro_email_text || "",
      0,
      now()
    );
    const user = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
    if (user) {
      db.prepare(
        "INSERT OR IGNORE INTO user_entity_access (user_id, entity_id) VALUES (?, ?)"
      ).run(user.id, id);
      seedDefaultEmailTemplates(id, user.id);
    }
    res.status(201).json(
      serializeEntity(db.prepare("SELECT * FROM entities WHERE id = ?").get(id))
    );
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch("/api/entities/:id", (req, res) => {
  const entity = db
    .prepare("SELECT * FROM entities WHERE id = ? AND is_active = 1")
    .get(req.params.id);
  if (!entity) return res.status(404).json({ error: "Not found" });
  const body = req.body || {};
  const brand = {
    ...parseJson(entity.brand_json, {}),
    ...(body.brand || {}),
  };
  const signature = normalizeGmailSignature(
    body.email_signature_html ?? entity.email_signature_html,
    body.email_signature_text ?? entity.email_signature_text
  );
  db.prepare(
    `UPDATE entities SET
      legal_name = ?,
      company_number = ?,
      vat_number = ?,
      registered_office = ?,
      display_name = ?,
      brand_json = ?,
      sending_domain = ?,
      from_address = ?,
      reply_to = ?,
      email_signature_html = ?,
      email_signature_text = ?,
      intro_email_text = ?,
      smtp_host = ?,
      smtp_port = ?,
      smtp_user = ?,
      smtp_pass = ?,
      smtp_provider = ?
     WHERE id = ?`
  ).run(
    body.legal_name ?? entity.legal_name,
    body.company_number ?? entity.company_number,
    body.vat_number ?? entity.vat_number,
    body.registered_office ?? entity.registered_office,
    body.display_name ?? entity.display_name,
    JSON.stringify(brand),
    body.sending_domain ?? entity.sending_domain,
    body.from_address ?? entity.from_address,
    body.reply_to ?? entity.reply_to,
    signature.html,
    signature.text,
    body.intro_email_text !== undefined ? body.intro_email_text : entity.intro_email_text,
    body.smtp_host !== undefined ? body.smtp_host : entity.smtp_host,
    body.smtp_port !== undefined && body.smtp_port !== ""
      ? Number(body.smtp_port)
      : entity.smtp_port,
    body.smtp_user !== undefined ? body.smtp_user : entity.smtp_user,
    body.smtp_clear
      ? null
      : String(body.smtp_pass || "").trim()
        ? String(body.smtp_pass).trim()
        : entity.smtp_pass,
    body.smtp_provider !== undefined ? body.smtp_provider : entity.smtp_provider,
    entity.id
  );
  const next = db.prepare("SELECT * FROM entities WHERE id = ?").get(entity.id);
  if (
    String(next.sending_domain || "").toLowerCase() !==
      String(entity.sending_domain || "").toLowerCase() ||
    String(next.from_address || "").toLowerCase() !==
      String(entity.from_address || "").toLowerCase()
  ) {
    clearVerification(entity.id);
  }
  res.json(serializeEntity(db.prepare("SELECT * FROM entities WHERE id = ?").get(entity.id)));
});

app.post("/api/ingest-image", async (req, res) => {
  try {
    const dataUrl = await fetchRemoteImageDataUrl(req.body?.url);
    res.json({ dataUrl });
  } catch (err) {
    res.status(400).json({ error: err.message || "Could not fetch image" });
  }
});

app.delete("/api/entities/:id", (req, res) => {
  const entity = db.prepare("SELECT * FROM entities WHERE id = ?").get(req.params.id);
  if (!entity || !entity.is_active) {
    return res.status(404).json({ error: "Not found" });
  }
  db.prepare("UPDATE entities SET is_active = 0 WHERE id = ?").run(entity.id);
  res.status(204).end();
});

app.post("/api/entities/:id/verify/dns", async (req, res) => {
  try {
    res.json(await verifyDns(req.params.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/entities/:id/verify/email", async (req, res) => {
  try {
    const sent = await sendVerifyCode(req.params.id);
    res.json({
      ...sent,
      verify_email: latestVerifyEmail(req.params.id),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/entities/:id/verify/code", (req, res) => {
  try {
    res.json(confirmVerifyCode(req.params.id, req.body?.code));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/entities/:id/mail/test", async (req, res) => {
  const entity = db
    .prepare("SELECT * FROM entities WHERE id = ? AND is_active = 1")
    .get(req.params.id);
  if (!entity) return res.status(404).json({ error: "Not found" });
  try {
    res.json(await verifySmtp(entity, req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/entities/:id/mail/test-send", async (req, res) => {
  const entity = db
    .prepare("SELECT * FROM entities WHERE id = ? AND is_active = 1")
    .get(req.params.id);
  if (!entity) return res.status(404).json({ error: "Not found" });
  try {
    const merged = { ...entity, ...(req.body || {}) };
    if (!String(req.body?.smtp_pass || "").trim()) merged.smtp_pass = entity.smtp_pass;
    const to = merged.from_address || entity.from_address;
    const delivery = await deliverMail({
      entity: merged,
      to,
      subject: `Attest mail test for ${entity.display_name}`,
      text: "This is a test from Attest. If you received it, this company can send from this mailbox.",
      html: "<p>This is a test from Attest. If you received it, this company can send from this mailbox.</p>",
      allowOutlook: false,
    });
    res.json({ sent: true, to, via: delivery.via });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/entities/:id/mail/disconnect", (req, res) => {
  const entity = db
    .prepare("SELECT * FROM entities WHERE id = ? AND is_active = 1")
    .get(req.params.id);
  if (!entity) return res.status(404).json({ error: "Not found" });
  db.prepare("UPDATE entities SET smtp_pass = NULL WHERE id = ?").run(entity.id);
  res.json(serializeEntity(db.prepare("SELECT * FROM entities WHERE id = ?").get(entity.id)));
});

app.post("/api/entities/:id/assets", upload.single("file"), (req, res) => {
  try {
    const entity = db.prepare("SELECT * FROM entities WHERE id = ?").get(req.params.id);
    if (!entity) return res.status(404).json({ error: "Not found" });
    const kind = req.body.kind;
    if (!["front_cover", "back_cover", "logo", "email_header"].includes(kind)) {
      return res.status(400).json({ error: "Invalid asset kind" });
    }
    if (!req.file) return res.status(400).json({ error: "File required" });
    const stored = writeBytes(
      "assets",
      `${entity.id}-${kind}-${Date.now()}-${req.file.originalname}`,
      req.file.buffer
    );
    // deactivate previous active of same kind so new one becomes the auto-applied default
    db.prepare(
      "UPDATE entity_assets SET is_active = 0 WHERE entity_id = ? AND kind = ?"
    ).run(entity.id, kind);
    const id = newId();
    db.prepare(
      `INSERT INTO entity_assets (
        id, entity_id, kind, name, storage_ref, mime, page_size, is_active, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`
    ).run(
      id,
      entity.id,
      kind,
      req.body.name || req.file.originalname,
      stored.storageRef,
      assetMime(req.file),
      req.body.page_size || "A4",
      now()
    );
    if (kind === "logo") {
      const brand = parseJson(entity.brand_json, {});
      brand.logo_asset_id = id;
      db.prepare("UPDATE entities SET brand_json = ? WHERE id = ?").run(
        JSON.stringify(brand),
        entity.id
      );
    }
    res.status(201).json(db.prepare("SELECT * FROM entity_assets WHERE id = ?").get(id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/entities/:id/assets/:assetId", (req, res) => {
  const asset = db
    .prepare("SELECT * FROM entity_assets WHERE id = ? AND entity_id = ?")
    .get(req.params.assetId, req.params.id);
  if (!asset || !asset.is_active) {
    return res.status(404).json({ error: "Not found" });
  }
  db.prepare("UPDATE entity_assets SET is_active = 0 WHERE id = ?").run(asset.id);
  if (asset.kind === "logo") {
    const entity = db.prepare("SELECT * FROM entities WHERE id = ?").get(asset.entity_id);
    const brand = parseJson(entity?.brand_json, {});
    if (brand.logo_asset_id === asset.id) {
      brand.logo_asset_id = null;
      db.prepare("UPDATE entities SET brand_json = ? WHERE id = ?").run(
        JSON.stringify(brand),
        asset.entity_id
      );
    }
  }
  res.status(204).end();
});

app.get("/api/entities/:id/assets/:assetId/file", (req, res) => {
  const asset = db
    .prepare("SELECT * FROM entity_assets WHERE id = ? AND entity_id = ?")
    .get(req.params.assetId, req.params.id);
  if (!asset) return res.status(404).json({ error: "Not found" });
  const bytes = readBytes(asset.storage_ref);
  res.setHeader("Content-Type", asset.mime || "application/octet-stream");
  res.setHeader("Content-Disposition", `inline; filename="${asset.name || "signature"}"`);
  res.send(bytes);
});

app.get("/api/templates", (_req, res) => {
  const templates = db
    .prepare("SELECT * FROM templates ORDER BY is_master DESC, created_at DESC")
    .all();
  res.json(
    templates.map((t) => ({
      ...t,
      is_master: Boolean(t.is_master),
      roles: db
        .prepare("SELECT * FROM template_roles WHERE template_id = ? ORDER BY signing_order")
        .all(t.id),
      fields: db.prepare("SELECT * FROM template_fields WHERE template_id = ?").all(t.id),
    }))
  );
});

app.get("/api/templates/master", (_req, res) => {
  const t = getMasterTemplate();
  if (!t) return res.json(null);
  const roles = db
    .prepare("SELECT * FROM template_roles WHERE template_id = ? ORDER BY signing_order")
    .all(t.id);
  const fields = db.prepare("SELECT * FROM template_fields WHERE template_id = ?").all(t.id);
  res.json({ ...t, is_master: true, roles, fields, file_name: fileNameFromRef(t.source_url) });
});

app.patch("/api/templates/master", (req, res) => {
  const t = getMasterTemplate();
  if (!t) return res.status(404).json({ error: "Master contract not found" });
  const body = req.body || {};
  db.prepare(
    `UPDATE templates SET
      name = ?,
      description = ?
     WHERE id = ?`
  ).run(body.name ?? t.name, body.description ?? t.description, t.id);
  res.json(db.prepare("SELECT * FROM templates WHERE id = ?").get(t.id));
});

app.post("/api/templates/master/file", upload.single("file"), async (req, res) => {
  try {
    let t = getMasterTemplate({ includeInactive: true });
    if (!req.file) return res.status(400).json({ error: "PDF file required" });
    const stored = writeBytes(
      "uploads",
      `master-${Date.now()}-${req.file.originalname}`,
      req.file.buffer
    );
    if (!t) {
      const id = newId();
      db.prepare(
        `INSERT INTO templates (
          id, entity_id, name, source_url, default_front_cover, default_back_cover,
          is_active, created_at, industry, description, is_master
        ) VALUES (?, NULL, ?, ?, NULL, NULL, 1, ?, NULL, ?, 1)`
      ).run(
        id,
        req.body.name || "Master Services Agreement",
        `local://${stored.storageRef}`,
        now(),
        req.body.description || "Core three-party agreement included on every contract"
      );
      // roles added lazily if missing — seed helper not imported; create minimal roles
      const roleDefs = [
        ["supplier", "Contractor", 1, 1],
        ["spv", "Supplier (SPV)", 2, 1],
        ["agency", "Broker", 3, 0],
        ["company", "Client", 4, 1],
      ];
      const roleIds = {};
      for (const [key, label, order, evidence] of roleDefs) {
        const rid = newId();
        roleIds[key] = rid;
        db.prepare(
          `INSERT INTO template_roles (
            id, template_id, role_key, label, signing_order, evidence_required
          ) VALUES (?, ?, ?, ?, ?, ?)`
        ).run(rid, id, key, label, order, evidence);
      }
      ensureSigningEvidence();
      await applyMasterPdfFields(id, req.file.buffer, { isNew: true });
      t = db.prepare("SELECT * FROM templates WHERE id = ?").get(id);
    } else {
      db.prepare(
        "UPDATE templates SET source_url = ?, name = COALESCE(?, name), is_active = 1, is_master = 1 WHERE id = ?"
      ).run(`local://${stored.storageRef}`, req.body.name || null, t.id);
      await applyMasterPdfFields(t.id, req.file.buffer, { isNew: false });
      t = db.prepare("SELECT * FROM templates WHERE id = ?").get(t.id);
    }
    const roles = db
      .prepare("SELECT * FROM template_roles WHERE template_id = ? ORDER BY signing_order")
      .all(t.id);
    const fields = db.prepare("SELECT * FROM template_fields WHERE template_id = ?").all(t.id);
    res.json({ ...t, is_master: true, roles, fields, file_name: fileNameFromRef(t.source_url) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/templates/master/file", (_req, res) => {
  const t = getMasterTemplate();
  if (!t) return res.status(404).json({ error: "Master contract not found" });
  try {
    sendStoredPdf(res, t.source_url, fileNameFromRef(t.source_url));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.delete("/api/templates/master", (_req, res) => {
  const t = getMasterTemplate();
  if (!t) return res.status(404).json({ error: "Master contract not found" });
  db.prepare("UPDATE templates SET is_active = 0 WHERE id = ?").run(t.id);
  res.status(204).end();
});

app.get("/api/templates/:id", (req, res) => {
  const t = db.prepare("SELECT * FROM templates WHERE id = ?").get(req.params.id);
  if (!t) return res.status(404).json({ error: "Not found" });
  const roles = db
    .prepare("SELECT * FROM template_roles WHERE template_id = ? ORDER BY signing_order")
    .all(t.id)
    .map((role) => ({
      ...role,
      evidence_required: Boolean(role.evidence_required),
      evidence_requirements: db
        .prepare("SELECT * FROM evidence_requirements WHERE role_id = ?")
        .all(role.id)
        .map((r) => ({ ...r, accepted_mimes: JSON.parse(r.accepted_mimes || "[]") })),
    }));
  const fields = db.prepare("SELECT * FROM template_fields WHERE template_id = ?").all(t.id);
  const versions = db
    .prepare(
      "SELECT * FROM template_versions WHERE template_id = ? ORDER BY version_no DESC"
    )
    .all(t.id);
  res.json({ ...t, is_master: Boolean(t.is_master), roles, fields, versions });
});

app.get("/api/appendices", (req, res) => {
  const industry = req.query.industry || null;
  res.json(
    listAppendices({ industry: industry || undefined }).map((row) => {
      const fields = listAppendixFields(row.id);
      return {
        ...row,
        fields,
        needs_signing: fields.length > 0,
        file_name: fileNameFromRef(row.storage_ref),
      };
    })
  );
});

app.post("/api/appendices", upload.single("file"), async (req, res) => {
  try {
    const name = req.body.name;
    const industry = req.body.industry;
    if (!name || !industry) {
      return res.status(400).json({ error: "name and industry required" });
    }
    if (!req.file) return res.status(400).json({ error: "PDF file required" });
    const stored = writeBytes(
      "uploads",
      `appendix-${industry}-${Date.now()}-${req.file.originalname}`,
      req.file.buffer
    );
    const id = newId();
    db.prepare(
      `INSERT INTO appendices (
        id, entity_id, industry, name, description, storage_ref, is_active, created_at
      ) VALUES (?, NULL, ?, ?, ?, ?, 1, ?)`
    ).run(
      id,
      industry,
      name,
      req.body.description || null,
      stored.storageRef,
      now()
    );
    await applyAppendixPdfFields(id, req.file.buffer);
    const row = db.prepare("SELECT * FROM appendices WHERE id = ?").get(id);
    const fields = listAppendixFields(id);
    res.status(201).json({ ...row, fields, needs_signing: fields.length > 0 });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch("/api/appendices/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM appendices WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Not found" });
  const body = req.body || {};
  db.prepare(
    `UPDATE appendices SET
      name = ?,
      industry = ?,
      description = ?,
      is_active = ?
     WHERE id = ?`
  ).run(
    body.name ?? row.name,
    body.industry ?? row.industry,
    body.description ?? row.description,
    body.is_active === undefined ? row.is_active : body.is_active ? 1 : 0,
    row.id
  );
  res.json(db.prepare("SELECT * FROM appendices WHERE id = ?").get(row.id));
});

app.post("/api/appendices/:id/file", upload.single("file"), async (req, res) => {
  try {
    const row = db.prepare("SELECT * FROM appendices WHERE id = ?").get(req.params.id);
    if (!row) return res.status(404).json({ error: "Not found" });
    if (!req.file) return res.status(400).json({ error: "PDF file required" });
    const stored = writeBytes(
      "uploads",
      `appendix-${row.industry}-${Date.now()}-${req.file.originalname}`,
      req.file.buffer
    );
    db.prepare("UPDATE appendices SET storage_ref = ? WHERE id = ?").run(
      stored.storageRef,
      row.id
    );
    await applyAppendixPdfFields(row.id, req.file.buffer);
    const updated = db.prepare("SELECT * FROM appendices WHERE id = ?").get(row.id);
    const fields = listAppendixFields(row.id);
    res.json({ ...updated, fields, needs_signing: fields.length > 0 });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/appendices/:id/file", (req, res) => {
  const row = db.prepare("SELECT * FROM appendices WHERE id = ? AND is_active = 1").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Not found" });
  try {
    sendStoredPdf(res, row.storage_ref, fileNameFromRef(row.storage_ref));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.delete("/api/appendices/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM appendices WHERE id = ? AND is_active = 1").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Not found" });
  db.prepare("UPDATE appendices SET is_active = 0 WHERE id = ?").run(row.id);
  res.status(204).end();
});

app.get("/api/envelopes", (_req, res) => {
  const rows = db
    .prepare("SELECT * FROM envelopes ORDER BY created_at DESC")
    .all()
    .map((e) => {
      const entity = db.prepare("SELECT display_name, slug FROM entities WHERE id = ?").get(e.entity_id);
      const parties = db
        .prepare("SELECT status, role_id FROM envelope_parties WHERE envelope_id = ?")
        .all(e.id);
      return { ...e, entity, party_count: parties.length, parties };
    });
  res.json(rows);
});

app.get("/api/envelopes/:id", (req, res) => {
  const bundle = getEnvelopeBundle(req.params.id);
  if (!bundle) return res.status(404).json({ error: "Not found" });
  res.json(bundle);
});

app.post("/api/envelopes", (req, res) => {
  try {
    let {
      entityId,
      title,
      preparedOn,
      industry,
      appendixIds = [],
      externalClientRef,
      parties,
      reminderFrequency = "none",
    } = req.body || {};
    let template = getMasterTemplate();
    let shape = req.body?.shape === "four" ? "four" : "three";
    if (req.body?.libraryId) {
      const built = contractFromLibrary(req.body);
      entityId = built.entityId;
      parties = built.parties;
      shape = built.shape;
      template = db.prepare("SELECT * FROM templates WHERE id = ?").get(built.templateId);
    }
    const entity = db
      .prepare("SELECT * FROM entities WHERE id = ? AND is_active = 1")
      .get(entityId);
    if (!entity) return res.status(400).json({ error: "Unknown entity" });
    if (!template) return res.status(400).json({ error: "Master contract is not configured" });
    if (!preparedOn || !/^\d{4}-\d{2}-\d{2}$/.test(preparedOn)) {
      return res.status(400).json({ error: "preparedOn (YYYY-MM-DD) is required" });
    }
    const selectedIndustry = industry || null;
    const requestedAppendixIds = Array.isArray(appendixIds) ? appendixIds : [];
    const available = selectedIndustry
      ? listAppendices({ industry: selectedIndustry, entityId })
      : [];
    const availableIds = new Set(available.map((a) => a.id));
    for (const id of requestedAppendixIds) {
      if (!availableIds.has(id)) {
        return res.status(400).json({
          error: `Appendix ${id} is not available for industry ${selectedIndustry || "(none)"}`,
        });
      }
    }
    const selectedAppendices = listAppendices({ ids: requestedAppendixIds });
    const brand = resolveBrandPack(entityId, {
      industry: selectedIndustry,
      appendixIds: requestedAppendixIds,
    });
    const wanted = SIGN_ORDER.filter((key) => shape === "four" || key !== "spv");
    const roles = db
      .prepare("SELECT * FROM template_roles WHERE template_id = ? ORDER BY signing_order")
      .all(template.id);
    const roleByKey = Object.fromEntries(roles.map((role) => [role.role_key, role]));
    for (const key of wanted) {
      if (!roleByKey[key]) {
        return res.status(400).json({ error: `Master contract is missing the ${key} role` });
      }
    }
    if (!Array.isArray(parties) || parties.length !== wanted.length) {
      return res.status(400).json({
        error:
          shape === "four"
            ? "A 4-way contract needs the contractor, supplier, broker and client"
            : "A 3-way contract needs the contractor, broker and client",
      });
    }

    const user = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
    const envelopeId = newId();
    db.prepare(
      `INSERT INTO envelopes (
        id, entity_id, template_id, status, signing_mode, reminder_frequency, max_auto_reminders,
        external_client_ref, title, prepared_on, industry, front_cover_id, back_cover_id,
        logo_asset_id, appendix_ids_json, created_by, created_at, party_shape, is_sample
      ) VALUES (?, ?, ?, 'draft', 'sequential', ?, 5, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      envelopeId,
      entityId,
      template.id,
      reminderFrequency,
      externalClientRef || null,
      title || template.name,
      preparedOn,
      selectedIndustry,
      brand.front?.id || null,
      brand.back?.id || null,
      brand.logo?.id || null,
      JSON.stringify(selectedAppendices.map((a) => a.id)),
      user?.id || null,
      now(),
      shape,
      parties.some((party) => party.is_sample) ? 1 : 0
    );

    wanted.forEach((key, index) => {
      const role = roleByKey[key];
      const incoming = parties.find((p) => p.roleKey === role.role_key);
      if (!incoming?.signer_name || !incoming?.signer_email || !incoming?.company_name) {
        throw new Error(`Missing party details for ${role.label || role.role_key}`);
      }
      if (!["director", "authorised_signatory"].includes(incoming.signer_role)) {
        throw new Error(
          `${role.label || role.role_key} needs a role: director, or authorised signatory`
        );
      }
      db.prepare(
        `INSERT INTO envelope_parties (
          id, envelope_id, role_id, company_name, company_number, registered_office, directory_party_id,
          signer_name, signer_email, signer_role,
          status, order_index, is_sample
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
      ).run(
        newId(),
        envelopeId,
        role.id,
        incoming.company_name,
        incoming.company_number || "",
        incoming.registered_office || "",
        incoming.directory_party_id || null,
        incoming.signer_name,
        incoming.signer_email,
        incoming.signer_role,
        index + 1,
        incoming.is_sample ? 1 : 0
      );
    });

    appendEvent({
      envelopeId,
      actor: user ? `staff:${user.id}` : "staff",
      eventType: "envelope_created",
      metadata: {
        template_id: template.id,
        title: title || template.name,
        prepared_on: preparedOn,
        industry: selectedIndustry,
        auto_front_cover_id: brand.front?.id || null,
        auto_back_cover_id: brand.back?.id || null,
        auto_logo_asset_id: brand.logo?.id || null,
        appendix_ids: selectedAppendices.map((a) => a.id),
        party_shape: shape,
      },
    });

    res.status(201).json(getEnvelopeBundle(envelopeId));
  } catch (err) {
    res.status(400).json({ error: err.message || "Create failed" });
  }
});

app.post("/api/envelopes/:id/bake", async (req, res) => {
  try {
    await bakeEnvelope(req.params.id, { actor: "staff" });
    res.json(getEnvelopeBundle(req.params.id));
  } catch (err) {
    res.status(400).json({ error: err.message || "Bake failed" });
  }
});

app.post("/api/envelopes/:id/send", async (req, res) => {
  try {
    const baseUrl = publicBase(req);
    assertContractMayBeIssued(req.params.id);
    await bakeInSignedPack(req.params.id, { actor: "staff" });
    const result = startSigningInvites(req.params.id, baseUrl, "staff");
    res.json({ ...getEnvelopeBundle(req.params.id), invite: result });
  } catch (err) {
    res.status(400).json({ error: err.message || "Send failed" });
  }
});

app.post("/api/envelopes/:id/void", (req, res) => {
  const envelope = db.prepare("SELECT * FROM envelopes WHERE id = ?").get(req.params.id);
  if (!envelope) return res.status(404).json({ error: "Not found" });
  if (["completed", "declined", "voided", "expired"].includes(envelope.status)) {
    return res.status(400).json({ error: "Envelope already terminal" });
  }
  const reason = req.body?.reason || "Voided by staff";
  db.prepare(
    "UPDATE envelopes SET status = 'voided', void_reason = ? WHERE id = ?"
  ).run(reason, envelope.id);
  db.prepare(
    "UPDATE party_access_tokens SET revoked_at = ? WHERE party_id IN (SELECT id FROM envelope_parties WHERE envelope_id = ?) AND revoked_at IS NULL"
  ).run(now(), envelope.id);
  appendEvent({
    envelopeId: envelope.id,
    actor: "staff",
    eventType: "voided",
    metadata: { reason },
  });
  res.json(getEnvelopeBundle(envelope.id));
});

app.get("/api/envelopes/:id/documents/:kind", (req, res) => {
  const doc = db
    .prepare(
      "SELECT * FROM documents WHERE envelope_id = ? AND kind = ? ORDER BY created_at DESC LIMIT 1"
    )
    .get(req.params.id, req.params.kind);
  if (!doc) return res.status(404).json({ error: "Document not found" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${req.params.kind}.pdf"`);
  res.send(readBytes(doc.storage_ref));
});

app.get("/api/events/verify", (req, res) => {
  res.json(verifyEventChain(req.query.envelopeId || null));
});

// Signing room (tokenized)
app.get("/api/sign/:token", (req, res) => {
  const token = resolveToken(req.params.token);
  if (!token) return res.status(401).json({ error: "Invalid or expired token" });
  const { ip, userAgent } = clientMeta(req);
  const party = db.prepare("SELECT * FROM envelope_parties WHERE id = ?").get(token.party_id);
  const envelope = getEnvelopeBundle(token.envelope_id);
  const role = db.prepare("SELECT * FROM template_roles WHERE id = ?").get(party.role_id);
  const fields = fieldsForParty(token.envelope_id, party.role_id);
  const values = db
    .prepare("SELECT * FROM field_values WHERE envelope_id = ? AND party_id = ?")
    .all(token.envelope_id, party.id);

  if (party.status === "notified") {
    db.prepare("UPDATE envelope_parties SET status = 'viewed' WHERE id = ?").run(party.id);
    appendEvent({
      envelopeId: token.envelope_id,
      partyId: party.id,
      actor: "party",
      eventType: "document_viewed",
      ip,
      userAgent,
    });
  }

  const checklist = evidenceChecklist(party.id);
  const gate = evidenceGateOpen(party.id);
  const actionable = getActionableParty(token.envelope_id);

  res.json({
    consent_text: CONSENT_TEXT,
    party: { ...party, role_key: role.role_key, role_label: role.label },
    envelope,
    fields,
    values,
    checklist,
    gate,
    is_turn: actionable?.id === party.id,
    document_url: `/api/envelopes/${token.envelope_id}/documents/baked`,
  });
});

app.post("/api/sign/:token/fields", (req, res) => {
  try {
    const token = resolveToken(req.params.token);
    if (!token) return res.status(401).json({ error: "Invalid or expired token" });
    const { fieldId, value } = req.body || {};
    const field = getSignField(token.envelope_id, fieldId, token.role_id);
    if (!field) return res.status(400).json({ error: "Unknown field" });
    if (field.role_id !== token.role_id) {
      return res.status(403).json({ error: "Field not owned by this role" });
    }
    const { ip } = clientMeta(req);
    const valueHash = sha256(String(value ?? ""));
    const existing = db
      .prepare("SELECT id FROM field_values WHERE envelope_id = ? AND field_id = ?")
      .get(token.envelope_id, fieldId);
    if (existing) {
      db.prepare(
        `UPDATE field_values SET value = ?, value_hash = ?, captured_at = ?, captured_ip = ?, party_id = ?
         WHERE id = ?`
      ).run(String(value ?? ""), valueHash, now(), ip, token.party_id, existing.id);
    } else {
      db.prepare(
        `INSERT INTO field_values (
          id, envelope_id, field_id, party_id, value, value_hash, captured_at, captured_ip
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        newId(),
        token.envelope_id,
        fieldId,
        token.party_id,
        String(value ?? ""),
        valueHash,
        now(),
        ip
      );
    }
    appendEvent({
      envelopeId: token.envelope_id,
      partyId: token.party_id,
      actor: "party",
      eventType: "field_completed",
      metadata: { field_id: fieldId, field_key: field.field_key },
      ip,
    });
    db.prepare(
      "UPDATE envelope_parties SET status = 'in_progress' WHERE id = ? AND status IN ('viewed','notified')"
    ).run(token.party_id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/sign/:token/evidence", upload.single("file"), (req, res) => {
  try {
    const token = resolveToken(req.params.token);
    if (!token) return res.status(401).json({ error: "Invalid or expired token" });
    const requirementId = String(req.body?.requirementId || "");
    const reqRow = db
      .prepare("SELECT * FROM evidence_requirements WHERE id = ?")
      .get(requirementId);
    if (!reqRow) return res.status(400).json({ error: "Unknown requirement" });
    if (reqRow.role_id !== token.role_id) {
      return res.status(403).json({ error: "Requirement not for this role" });
    }
    if (!req.file) return res.status(400).json({ error: "File required" });
    if (req.file.size > (reqRow.max_size_bytes || 10 * 1024 * 1024)) {
      return res.status(400).json({ error: "File too large" });
    }
    const buf = req.file.buffer;
    const isPdf = buf.slice(0, 5).toString() === "%PDF-";
    const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
    const isPng = buf.slice(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    if (!(isPdf || isJpeg || isPng)) {
      return res.status(400).json({ error: "File content does not match PDF/JPEG/PNG" });
    }
    const mime = String(req.file.mimetype || "").toLowerCase();
    const accepted = JSON.parse(reqRow.accepted_mimes || "[]");
    if (
      accepted.length &&
      mime &&
      mime !== "application/octet-stream" &&
      !accepted.includes(mime)
    ) {
      return res.status(400).json({ error: `MIME not accepted: ${req.file.mimetype}` });
    }

    const stored = writeBytes(
      "evidence",
      `${token.party_id}-${reqRow.requirement_key}-${Date.now()}`,
      buf
    );
    const { ip } = clientMeta(req);
    const id = newId();
    const retention = new Date();
    retention.setFullYear(retention.getFullYear() + 6);
    db.prepare(
      `INSERT INTO evidence_files (
        id, party_id, envelope_id, requirement_id, review_status, original_name,
        mime, size_bytes, storage_ref, file_hash, uploaded_at, uploaded_ip,
        retention_expires_at
      ) VALUES (?, ?, ?, ?, 'uploaded', ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      token.party_id,
      token.envelope_id,
      requirementId,
      req.file.originalname,
      req.file.mimetype,
      req.file.size,
      stored.storageRef,
      stored.sha256,
      now(),
      ip,
      retention.toISOString()
    );
    appendEvent({
      envelopeId: token.envelope_id,
      partyId: token.party_id,
      actor: "party",
      eventType: "evidence_uploaded",
      metadata: {
        requirement_key: reqRow.requirement_key,
        evidence_file_id: id,
        file_hash: stored.sha256,
        original_name: req.file.originalname,
      },
      ip,
    });
    res.status(201).json({
      ok: true,
      checklist: evidenceChecklist(token.party_id),
      gate: evidenceGateOpen(token.party_id),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/sign/:token/sign", async (req, res) => {
  try {
    const token = resolveToken(req.params.token);
    if (!token) return res.status(401).json({ error: "Invalid or expired token" });
    const { typedName, consent } = req.body || {};
    if (!consent) return res.status(400).json({ error: "Consent required" });
    const signature = readSignatureInput(req.body);
    const { ip, userAgent } = clientMeta(req);

    const result = await applySignatureAndCompleteParty({
      envelopeId: token.envelope_id,
      partyId: token.party_id,
      method: signature.method,
      font: signature.font,
      signatureDataUrl: signature.dataUrl,
      typedName,
      ip,
      userAgent,
      tokenRow: token,
    });

    if (result.nextPartyId) {
      inviteParty(token.envelope_id, result.nextPartyId, {
        baseUrl: publicBase(req),
        actor: "system",
      });
    }

    res.json({
      ok: true,
      ...result,
      envelope: getEnvelopeBundle(token.envelope_id),
    });
  } catch (err) {
    res.status(400).json({ error: err.message || "Sign failed" });
  }
});

app.post("/api/sign/:token/decline", (req, res) => {
  const token = resolveToken(req.params.token);
  if (!token) return res.status(401).json({ error: "Invalid or expired token" });
  const reason = req.body?.reason || "Declined";
  const { ip, userAgent } = clientMeta(req);
  db.prepare(
    "UPDATE envelope_parties SET status = 'declined', declined_reason = ? WHERE id = ?"
  ).run(reason, token.party_id);
  db.prepare("UPDATE envelopes SET status = 'declined' WHERE id = ?").run(token.envelope_id);
  db.prepare(
    "UPDATE party_access_tokens SET revoked_at = ? WHERE party_id IN (SELECT id FROM envelope_parties WHERE envelope_id = ?)"
  ).run(now(), token.envelope_id);
  appendEvent({
    envelopeId: token.envelope_id,
    partyId: token.party_id,
    actor: "party",
    eventType: "declined",
    metadata: { reason },
    ip,
    userAgent,
  });
  res.json(getEnvelopeBundle(token.envelope_id));
});

// Dev helper: mint a fresh link for a party (staff)
app.post("/api/envelopes/:id/dd/files", upload.single("file"), (req, res) => {
  try {
    const state = saveDueDiligenceFile(req.params.id, {
      roleKey: req.body?.roleKey,
      requirementKey: req.body?.requirementKey,
      nameChangeId: req.body?.nameChangeId || null,
      file: req.file,
    });
    res.status(201).json(state);
  } catch (err) {
    res.status(400).json({ error: err.message || "Upload failed" });
  }
});

app.post("/api/envelopes/:id/dd/name-changes", (req, res) => {
  try {
    res.status(201).json(
      addNameChange(req.params.id, {
        roleKey: req.body?.roleKey,
        previousName: req.body?.previousName,
        newName: req.body?.newName,
      })
    );
  } catch (err) {
    res.status(400).json({ error: err.message || "Could not add name change" });
  }
});

app.delete("/api/envelopes/:id/dd/name-changes/:changeId", (req, res) => {
  try {
    res.json(removeNameChange(req.params.id, req.params.changeId));
  } catch (err) {
    res.status(400).json({ error: err.message || "Could not remove name change" });
  }
});

app.post("/api/envelopes/:id/dd/office-changed", (req, res) => {
  try {
    res.json(setOfficeChanged(req.params.id, Boolean(req.body?.enabled)));
  } catch (err) {
    res.status(400).json({ error: err.message || "Could not update registered office" });
  }
});

app.post("/api/envelopes/:id/dd/compile", async (req, res) => {
  try {
    const state = await compileDueDiligence(req.params.id, "staff");
    res.json(state);
  } catch (err) {
    res.status(400).json({ error: err.message || "Could not compile the due diligence pack" });
  }
});

app.post("/api/envelopes/:id/dd/sign-link", (req, res) => {
  try {
    const state = dueDiligenceState(req.params.id);
    if (!state.hasFile) throw new Error("Compile the due diligence pack before signing it");
    if (state.validatedAt) throw new Error("The broker has already signed this pack");
    res.json(brokerDiligenceUrl(req.params.id, publicBase(req)));
  } catch (err) {
    res.status(400).json({ error: err.message || "Could not open the pack for signing" });
  }
});

app.get("/api/envelopes/:id/due-diligence", (req, res) => {
  const bytes = readDueDiligence(req.params.id);
  if (!bytes) return res.status(404).json({ error: "Due diligence pack has not been compiled" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", 'inline; filename="due-diligence.pdf"');
  res.send(bytes);
});

function requireDiligenceToken(req, res) {
  const token = resolveToken(req.params.token);
  if (!token) {
    res.status(401).json({ error: "Invalid or expired link" });
    return null;
  }
  return token;
}

app.get("/api/diligence/:token", (req, res) => {
  try {
    const token = requireDiligenceToken(req, res);
    if (!token) return;
    res.json(diligenceSession(token.party_id));
  } catch (err) {
    res.status(400).json({ error: err.message || "Could not open this page" });
  }
});

app.post("/api/diligence/:token/files", upload.single("file"), (req, res) => {
  try {
    const token = requireDiligenceToken(req, res);
    if (!token) return;
    const role = db.prepare("SELECT * FROM template_roles WHERE id = ?").get(token.role_id);
    saveDueDiligenceFile(token.envelope_id, {
      roleKey: role.role_key,
      requirementKey: req.body?.requirementKey,
      nameChangeId: req.body?.nameChangeId || null,
      file: req.file,
      partyId: token.party_id,
    });
    res.status(201).json(diligenceSession(token.party_id));
  } catch (err) {
    res.status(400).json({ error: err.message || "Upload failed" });
  }
});

app.post("/api/diligence/:token/name-changes", (req, res) => {
  try {
    const token = requireDiligenceToken(req, res);
    if (!token) return;
    const role = db.prepare("SELECT * FROM template_roles WHERE id = ?").get(token.role_id);
    addNameChange(token.envelope_id, {
      roleKey: role.role_key,
      previousName: req.body?.previousName,
      newName: req.body?.newName,
      partyId: token.party_id,
    });
    res.status(201).json(diligenceSession(token.party_id));
  } catch (err) {
    res.status(400).json({ error: err.message || "Could not add name change" });
  }
});

app.delete("/api/diligence/:token/name-changes/:changeId", (req, res) => {
  try {
    const token = requireDiligenceToken(req, res);
    if (!token) return;
    const role = db.prepare("SELECT * FROM template_roles WHERE id = ?").get(token.role_id);
    const change = db
      .prepare("SELECT * FROM company_name_changes WHERE id = ? AND envelope_id = ?")
      .get(req.params.changeId, token.envelope_id);
    if (!change || change.role_key !== role.role_key) {
      return res.status(404).json({ error: "Name change not found" });
    }
    removeNameChange(token.envelope_id, req.params.changeId);
    res.json(diligenceSession(token.party_id));
  } catch (err) {
    res.status(400).json({ error: err.message || "Could not remove name change" });
  }
});

app.post("/api/diligence/:token/office-changed", (req, res) => {
  try {
    const token = requireDiligenceToken(req, res);
    if (!token) return;
    const role = db.prepare("SELECT * FROM template_roles WHERE id = ?").get(token.role_id);
    if (role.role_key !== "supplier") {
      return res.status(403).json({ error: "Only the contractor records a registered-office change" });
    }
    setOfficeChanged(token.envelope_id, Boolean(req.body?.enabled));
    res.json(diligenceSession(token.party_id));
  } catch (err) {
    res.status(400).json({ error: err.message || "Could not update registered office" });
  }
});

app.post("/api/diligence/:token/submit", async (req, res) => {
  try {
    const token = requireDiligenceToken(req, res);
    if (!token) return;
    const role = db.prepare("SELECT * FROM template_roles WHERE id = ?").get(token.role_id);
    submitDueDiligence(token.envelope_id, role.role_key, token.party_id);
    res.json(diligenceSession(token.party_id));
  } catch (err) {
    res.status(400).json({ error: err.message || "Could not submit documents" });
  }
});

app.get("/api/diligence/:token/pack", (req, res) => {
  try {
    const token = requireDiligenceToken(req, res);
    if (!token) return;
    const role = db.prepare("SELECT * FROM template_roles WHERE id = ?").get(token.role_id);
    if (role.role_key !== "agency") {
      return res.status(403).json({ error: "Only the broker can open the compiled pack" });
    }
    const bytes = readDueDiligence(token.envelope_id);
    if (!bytes) return res.status(404).json({ error: "The due diligence pack is not ready yet" });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'inline; filename="due-diligence.pdf"');
    res.send(bytes);
  } catch (err) {
    res.status(400).json({ error: err.message || "Could not open the pack" });
  }
});

app.post("/api/diligence/:token/sign", async (req, res) => {
  try {
    const token = requireDiligenceToken(req, res);
    if (!token) return;
    const { ip, userAgent } = clientMeta(req);
    await signDueDiligence(token.envelope_id, {
      partyId: token.party_id,
      signature: readSignatureInput(req.body),
      typedName: req.body?.typedName,
      ip,
      userAgent,
    });
    res.json(diligenceSession(token.party_id));
  } catch (err) {
    res.status(400).json({ error: err.message || "Could not sign the pack" });
  }
});

app.post("/api/envelopes/:id/parties/:partyId/link", async (req, res) => {
  try {
    await bakeInSignedPack(req.params.id, { actor: "staff" });
    const result = inviteParty(req.params.id, req.params.partyId, {
      baseUrl: publicBase(req),
      actor: "staff",
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

if (isProd) {
  const clientDist = path.resolve(__dirname, "../../client/dist");
  app.use(express.static(clientDist));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(400).json({ error: err.message || "Request failed" });
});

app.listen(PORT, () => {
  console.log(`Attest API on http://localhost:${PORT}`);
  console.log(`Public base URL: ${BASE_URL}`);
});

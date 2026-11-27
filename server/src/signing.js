import { createHash, randomBytes } from "node:crypto";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { db, newId, now, sha256 } from "./db.js";
import { appendEvent } from "./events.js";
import { sendTemplatedEmail } from "./mail.js";
import { readBytes, writeBytes, writeBase64Png } from "./storage.js";
import { envelopePlacedFields, fieldsForParty } from "./documentFields.js";
import { FINAL_EVIDENCE, PARTY_LABELS, SIGNS_BY_LINK } from "./parties.js";
import { assertClientMayBeInvited, assertContractMayBeIssued } from "./dueDiligence.js";
import { localDay } from "./ddChecks.js";
import { stampContractDates, ukDate } from "./coverStamp.js";
import { SIGNATURE_MAX_HEIGHT } from "./signatureInput.js";
import { appendBoundAttachments, listSigningAttachments } from "./boundDocuments.js";
import {
  directorIdFile,
  directorIdRequirement,
  gapMessage,
  partiesSigningInApp,
  recordForEnvelopeParty,
  savedSignatureGaps,
} from "./savedSignatures.js";

const CONSENT_TEXT =
  "I agree to sign this document electronically. I understand that my electronic signature is as legally binding as a handwritten signature.";
const SAVED_SIGNATURE_TEXT =
  "Signature saved on the company record and applied when the contract was issued.";

export function hashToken(raw) {
  return createHash("sha256").update(raw).digest("hex");
}

export function issuePartyToken(partyId, { days = 14 } = {}) {
  const raw = randomBytes(32).toString("hex");
  const id = newId();
  const expires = new Date(Date.now() + days * 86400000).toISOString();
  // revoke prior tokens
  db.prepare(
    "UPDATE party_access_tokens SET revoked_at = ? WHERE party_id = ? AND revoked_at IS NULL AND used_at IS NULL"
  ).run(now(), partyId);
  db.prepare(
    `INSERT INTO party_access_tokens (id, party_id, token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, partyId, hashToken(raw), expires, now());
  return { raw, id, expiresAt: expires };
}

export function resolveToken(raw) {
  const tokenHash = hashToken(raw);
  const token = db
    .prepare(
      `SELECT t.*, p.envelope_id, p.status AS party_status, p.signer_name, p.signer_email,
              p.company_name, p.role_id, p.order_index
       FROM party_access_tokens t
       JOIN envelope_parties p ON p.id = t.party_id
       WHERE t.token_hash = ?`
    )
    .get(tokenHash);
  if (!token) return null;
  if (token.revoked_at) return null;
  if (token.used_at) return null;
  if (new Date(token.expires_at).getTime() < Date.now()) return null;
  return token;
}

export function getActionableParty(envelopeId) {
  const envelope = db.prepare("SELECT * FROM envelopes WHERE id = ?").get(envelopeId);
  if (!envelope || !["ready", "in_progress"].includes(envelope.status)) return null;
  return db
    .prepare(
      `SELECT * FROM envelope_parties
       WHERE envelope_id = ? AND status NOT IN ('completed','declined')
       ORDER BY order_index ASC LIMIT 1`
    )
    .get(envelopeId);
}

export function evidenceChecklist(partyId) {
  const party = db.prepare("SELECT * FROM envelope_parties WHERE id = ?").get(partyId);
  const role = db.prepare("SELECT * FROM template_roles WHERE id = ?").get(party.role_id);
  const allowed = new Set((FINAL_EVIDENCE[role.role_key] || []).map(([key]) => key));
  const requirements = db
    .prepare("SELECT * FROM evidence_requirements WHERE role_id = ? AND is_required = 1")
    .all(party.role_id)
    .filter((req) => allowed.has(req.requirement_key));
  const mapped = requirements.map((req) => {
    const files = db
      .prepare(
        `SELECT id, original_name, mime, uploaded_at, review_status
         FROM evidence_files
         WHERE party_id = ? AND requirement_id = ? AND deleted_at IS NULL
         ORDER BY uploaded_at DESC`
      )
      .all(partyId, req.id);
    const file = files[0] || null;
    const verification = db
      .prepare(
        `SELECT * FROM verification_results
         WHERE party_id = ? AND requirement_id = ?
         ORDER BY checked_at DESC LIMIT 1`
      )
      .get(partyId, req.id);
    const satisfied =
      files.some((f) => ["uploaded", "accepted"].includes(f.review_status)) ||
      verification?.result === "verified";
    return {
      ...req,
      accepted_mimes: JSON.parse(req.accepted_mimes || "[]"),
      files,
      file,
      verification: verification || null,
      satisfied: Boolean(satisfied),
      allow_multiple: false,
      evidence_required: Boolean(role.evidence_required),
    };
  });
  return mapped;
}

export function evidenceGateOpen(partyId) {
  const party = db.prepare("SELECT * FROM envelope_parties WHERE id = ?").get(partyId);
  const role = db.prepare("SELECT * FROM template_roles WHERE id = ?").get(party.role_id);
  if (!role.evidence_required) return { ok: true, checklist: [] };
  const checklist = evidenceChecklist(partyId);
  const missing = checklist.filter((c) => c.is_required && !c.satisfied);
  return { ok: missing.length === 0, checklist, missing };
}

export function inviteParty(envelopeId, partyId, { baseUrl, actor = "system" } = {}) {
  const envelope = db.prepare("SELECT * FROM envelopes WHERE id = ?").get(envelopeId);
  const entity = db.prepare("SELECT * FROM entities WHERE id = ?").get(envelope.entity_id);
  const party = db.prepare("SELECT * FROM envelope_parties WHERE id = ?").get(partyId);
  const role = db.prepare("SELECT * FROM template_roles WHERE id = ?").get(party.role_id);
  if (role.role_key === "company") assertClientMayBeInvited(envelopeId);
  const token = issuePartyToken(partyId);
  const signingLink = `${baseUrl}/sign/${token.raw}`;

  sendTemplatedEmail({
    entityId: entity.id,
    templateType: party.status === "pending" ? "invitation" : "resend",
    to: party.signer_email,
    envelopeId,
    partyId,
    actor,
    vars: {
      signer_name: party.signer_name,
      signer_company: party.company_name,
      entity_display_name: entity.display_name,
      envelope_title: envelope.title || "Document",
      signing_link: signingLink,
      expiry_date: envelope.expires_at || "",
      role_label: role.label || role.role_key,
      declined_by: "",
      decline_reason: "",
    },
  });

  db.prepare(
    "UPDATE envelope_parties SET status = CASE WHEN status = 'pending' THEN 'notified' ELSE status END WHERE id = ?"
  ).run(partyId);

  return { signingLink, tokenId: token.id };
}

const isCalendarDay = (day) =>
  /^\d{4}-\d{2}-\d{2}$/.test(day) && new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;

/**
 * The date each party signing in the app signed, entered when the contract is issued (today if left out).
 * Dates follow the sign order, are not before the contract was prepared and not after today.
 */
export function signingDatesFor(envelopeId, input = {}) {
  const envelope = db.prepare("SELECT prepared_on FROM envelopes WHERE id = ?").get(envelopeId);
  const today = localDay();
  const dates = {};
  let previous = null;
  for (const party of partiesSigningInApp(envelopeId)) {
    if (party.status === "completed") continue;
    const label = PARTY_LABELS[party.role_key] || party.role_label;
    const day = String(input?.[party.role_key] || today).trim();
    if (!isCalendarDay(day)) throw new Error(`${label}: enter the date signed`);
    if (day > today) throw new Error(`${label}: the date signed is after today`);
    if (envelope?.prepared_on && day < envelope.prepared_on) {
      throw new Error(`${label}: the date signed is before the contract was prepared (${ukDate(envelope.prepared_on)})`);
    }
    if (previous && day < previous.day) throw new Error(`${label}: the date signed is before the ${previous.label}’s`);
    dates[party.role_key] = day;
    previous = { day, label };
  }
  return dates;
}

export function startSigningInvites(envelopeId, baseUrl, actor = "staff", { signingDates } = {}) {
  assertContractMayBeIssued(envelopeId);
  const envelope = db.prepare("SELECT * FROM envelopes WHERE id = ?").get(envelopeId);
  if (!envelope || envelope.status !== "ready") {
    throw new Error("Envelope must be ready before inviting");
  }
  if (!envelope.baked_hash) throw new Error("Envelope is not baked");
  const gaps = savedSignatureGaps(envelopeId);
  if (gaps.length) throw new Error(gapMessage(gaps));
  const dates = signingDatesFor(envelopeId, signingDates);

  const issuedAt = now();
  db.prepare(
    "UPDATE envelopes SET issued_at = COALESCE(issued_at, ?) WHERE id = ?"
  ).run(issuedAt, envelopeId);
  applySavedSignatures(envelopeId, { actor, signingDates: dates });

  const client = getActionableParty(envelopeId);
  if (!client) throw new Error("No actionable party");
  const result = inviteParty(envelopeId, client.id, { baseUrl, actor });
  return { ...result, issuedAt };
}

function upsertFieldValue(envelopeId, fieldId, partyId, value, capturedAt) {
  const valueHash = sha256(String(value));
  const existing = db
    .prepare("SELECT id FROM field_values WHERE envelope_id = ? AND field_id = ?")
    .get(envelopeId, fieldId);
  if (existing) {
    db.prepare(
      "UPDATE field_values SET value = ?, value_hash = ?, captured_at = ?, captured_ip = NULL, party_id = ? WHERE id = ?"
    ).run(value, valueHash, capturedAt, partyId, existing.id);
    return;
  }
  db.prepare(
    `INSERT INTO field_values (id, envelope_id, field_id, party_id, value, value_hash, captured_at, captured_ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`
  ).run(newId(), envelopeId, fieldId, partyId, value, valueHash, capturedAt);
}

/** The director ID on the company record, bound into the completed contract like a document uploaded at signing. */
function attachDirectorId(envelopeId, party, file) {
  const requirement = directorIdRequirement(party);
  if (!requirement || !file) return;
  const held = db
    .prepare("SELECT id FROM evidence_files WHERE party_id = ? AND requirement_id = ? AND deleted_at IS NULL")
    .get(party.id, requirement.id);
  if (held) return;
  const bytes = readBytes(file.storage_ref);
  const stored = writeBytes("evidence", `${party.id}-director_id-${Date.now()}`, bytes);
  const retention = new Date();
  retention.setFullYear(retention.getFullYear() + 6);
  db.prepare(
    `INSERT INTO evidence_files (
      id, party_id, envelope_id, requirement_id, review_status, original_name,
      mime, size_bytes, storage_ref, file_hash, uploaded_at, uploaded_ip, retention_expires_at
    ) VALUES (?, ?, ?, ?, 'uploaded', ?, ?, ?, ?, ?, ?, NULL, ?)`
  ).run(
    newId(),
    party.id,
    envelopeId,
    requirement.id,
    file.original_name || requirement.label,
    file.mime,
    bytes.length,
    stored.storageRef,
    stored.sha256,
    now(),
    retention.toISOString()
  );
}

/**
 * The contractor, the supplier (4-way) and the broker sign in that order with the
 * signature saved on their record, each dated as entered when the contract is issued.
 * Only the client signs by link, last.
 */
export function applySavedSignatures(envelopeId, { actor = "staff", signingDates } = {}) {
  const gaps = savedSignatureGaps(envelopeId);
  if (gaps.length) throw new Error(gapMessage(gaps));
  const envelope = db.prepare("SELECT * FROM envelopes WHERE id = ?").get(envelopeId);
  const dates = signingDatesFor(envelopeId, signingDates);
  db.exec("BEGIN");
  try {
    signWithSavedSignatures(envelope, dates, actor);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function signWithSavedSignatures(envelope, dates, actor) {
  const envelopeId = envelope.id;
  let previous = 0;
  for (const party of partiesSigningInApp(envelopeId)) {
    if (party.status === "completed") continue;
    const signedOn = dates[party.role_key];
    previous = Math.max(Date.now(), previous + 1);
    const signedAt = new Date(previous).toISOString();
    const record = recordForEnvelopeParty(envelope, party);
    const sigFile = writeBytes("signatures", `${party.id}-${Date.now()}.png`, readBytes(record.signature_ref));
    attachDirectorId(envelopeId, party, directorIdFile(record.id));
    for (const field of fieldsForParty(envelopeId, party.role_id)) {
      if (field.field_type === "date") {
        upsertFieldValue(envelopeId, field.id, party.id, signedOn, signedAt);
      } else if (["signature", "initials"].includes(field.field_type)) {
        const value = record.signature_method === "typed" ? record.signature_text || party.signer_name : sigFile.storageRef;
        upsertFieldValue(envelopeId, field.id, party.id, value, signedAt);
      }
    }
    const sigId = newId();
    db.prepare(
      `INSERT INTO signatures (
        id, party_id, envelope_id, method, signature_asset_ref, document_hash,
        consent_text, consent_given_at, signed_at, ip, user_agent
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', 'Contract Builder')`
    ).run(
      sigId,
      party.id,
      envelopeId,
      record.signature_method,
      sigFile.storageRef,
      envelope.baked_hash,
      SAVED_SIGNATURE_TEXT,
      signedAt,
      signedAt
    );
    db.prepare(
      "UPDATE envelope_parties SET status = 'completed', completed_at = ?, signed_on = ? WHERE id = ?"
    ).run(signedAt, signedOn, party.id);
    appendEvent({
      envelopeId,
      partyId: party.id,
      actor,
      eventType: "signed",
      metadata: { signature_id: sigId, document_hash: envelope.baked_hash, saved_signature: true, signed_on: signedOn },
    });
  }
  db.prepare("UPDATE envelopes SET status = 'in_progress' WHERE id = ? AND status = 'ready'").run(envelopeId);
}

export function assertSignsByLink(partyId) {
  const role = db
    .prepare("SELECT r.role_key FROM envelope_parties p JOIN template_roles r ON r.id = p.role_id WHERE p.id = ?")
    .get(partyId);
  if (role?.role_key !== SIGNS_BY_LINK) {
    throw new Error("Only the client signs by link. The others sign with their saved signature when the contract is sent.");
  }
}

export async function applySignatureAndCompleteParty({
  envelopeId,
  partyId,
  method,
  signatureDataUrl,
  typedName,
  ip,
  userAgent,
  tokenRow,
}) {
  const envelope = db.prepare("SELECT * FROM envelopes WHERE id = ?").get(envelopeId);
  if (!["ready", "in_progress"].includes(envelope.status)) {
    throw new Error("Envelope is not open for signing");
  }
  if (!envelope.baked_hash) throw new Error("Missing baked hash");

  const actionable = getActionableParty(envelopeId);
  if (!actionable || actionable.id !== partyId) {
    throw new Error("It is not this party's turn");
  }

  const gate = evidenceGateOpen(partyId);
  if (!gate.ok) {
    throw new Error(
      `Evidence gate locked: missing ${gate.missing.map((m) => m.requirement_key).join(", ")}`
    );
  }

  // role-owned fields must be complete when required
  const fields = fieldsForParty(envelopeId, actionable.role_id);
  for (const field of fields) {
    if (!field.required) continue;
    if (field.field_type === "signature" || field.field_type === "initials") continue;
    const value = db
      .prepare(
        "SELECT * FROM field_values WHERE envelope_id = ? AND field_id = ?"
      )
      .get(envelopeId, field.id);
    if (!value?.value) {
      const label = String(field.label || "").replace(/[_.]{3,}/g, "").replace(/:\s*$/, "").trim();
      throw new Error(label ? `Fill in "${label}" before signing.` : "Fill in every box before signing.");
    }
  }

  const sigFile = writeBase64Png(
    "signatures",
    `${partyId}-${Date.now()}.png`,
    signatureDataUrl
  );

  const consentAt = now();
  const signedAt = consentAt;
  const sigId = newId();
  db.prepare(
    `INSERT INTO signatures (
      id, party_id, envelope_id, method, signature_asset_ref, document_hash,
      consent_text, consent_given_at, signed_at, ip, user_agent
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    sigId,
    partyId,
    envelopeId,
    method,
    sigFile.storageRef,
    envelope.baked_hash,
    CONSENT_TEXT,
    consentAt,
    signedAt,
    ip || "",
    userAgent || "unknown"
  );

  // store signature field values
  for (const field of fields.filter((f) =>
    ["signature", "initials"].includes(f.field_type)
  )) {
    const value = method === "typed" ? typedName || actionable.signer_name : sigFile.storageRef;
    const valueHash = sha256(String(value));
    const existing = db
      .prepare(
        "SELECT id FROM field_values WHERE envelope_id = ? AND field_id = ?"
      )
      .get(envelopeId, field.id);
    if (existing) {
      db.prepare(
        `UPDATE field_values SET value = ?, value_hash = ?, captured_at = ?, captured_ip = ?, party_id = ?
         WHERE id = ?`
      ).run(value, valueHash, signedAt, ip || null, partyId, existing.id);
    } else {
      db.prepare(
        `INSERT INTO field_values (
          id, envelope_id, field_id, party_id, value, value_hash, captured_at, captured_ip
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        newId(),
        envelopeId,
        field.id,
        partyId,
        value,
        valueHash,
        signedAt,
        ip || null
      );
    }
  }

  db.prepare(
    "UPDATE envelope_parties SET status = 'completed', completed_at = ? WHERE id = ?"
  ).run(signedAt, partyId);

  // burn token
  if (tokenRow?.id) {
    db.prepare(
      "UPDATE party_access_tokens SET used_at = ? WHERE id = ?"
    ).run(signedAt, tokenRow.id);
  }

  appendEvent({
    envelopeId,
    partyId,
    actor: `party`,
    eventType: "consent_given",
    metadata: { consent_text: CONSENT_TEXT },
    ip,
    userAgent,
  });
  appendEvent({
    envelopeId,
    partyId,
    actor: "party",
    eventType: "signed",
    metadata: {
      signature_id: sigId,
      document_hash: envelope.baked_hash,
    },
    ip,
    userAgent,
  });

  if (envelope.status === "ready") {
    db.prepare("UPDATE envelopes SET status = 'in_progress' WHERE id = ?").run(
      envelopeId
    );
  }

  const next = getActionableParty(envelopeId);
  if (next) {
    // caller supplies baseUrl via process env default
    return { nextPartyId: next.id, completed: false, signatureId: sigId };
  }

  await finalizeEnvelope(envelopeId);
  return { nextPartyId: null, completed: true, signatureId: sigId };
}

export async function finalizeEnvelope(envelopeId) {
  const envelope = db.prepare("SELECT * FROM envelopes WHERE id = ?").get(envelopeId);
  const entity = db.prepare("SELECT * FROM entities WHERE id = ?").get(envelope.entity_id);
  const baked = db
    .prepare("SELECT * FROM documents WHERE id = ?")
    .get(envelope.baked_document_id);
  const bakedBytes = envelope.baked_clean_ref ? readBytes(envelope.baked_clean_ref) : readBytes(baked.storage_ref);
  const pdf = await PDFDocument.load(bakedBytes);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const pages = pdf.getPages();
  const placed = envelopePlacedFields(envelopeId);
  const pageOffset = Number(envelope.contract_page_offset || 0);
  if (envelope.baked_clean_ref && !envelope.word_contract && pages[pageOffset]) {
    stampContractDates(pages[pageOffset], font, envelope);
  }

  const signatures = db
    .prepare("SELECT * FROM signatures WHERE envelope_id = ?")
    .all(envelopeId);

  for (const sig of signatures) {
    const party = db.prepare("SELECT * FROM envelope_parties WHERE id = ?").get(sig.party_id);
    const fields = placed.length
      ? placed.filter(
          (f) =>
            f.role_id === party.role_id &&
            ["signature", "initials"].includes(f.field_type)
        )
      : db
          .prepare(
            `SELECT * FROM template_fields
             WHERE role_id = ? AND field_type IN ('signature','initials')`
          )
          .all(party.role_id);
    const pngBytes = readBytes(sig.signature_asset_ref);
    const image = await pdf.embedPng(pngBytes);
    for (const field of fields) {
      const pageIndex = placed.length
        ? Number(field.page || 0)
        : pageOffset + (field.page || 0);
      const page = pages[Math.min(pageIndex, pages.length - 1)];
      const box = { x: Number(field.x), y: Number(field.y), w: Number(field.w), h: Number(field.h) };
      const scale = Math.min(box.w / image.width, Math.min(box.h, SIGNATURE_MAX_HEIGHT) / image.height);
      const height = image.height * scale;
      page.drawImage(image, {
        x: box.x,
        y: box.y + (box.h - height) / 2,
        width: image.width * scale,
        height,
      });
    }
  }

  // text field values
  const values = placed.length
    ? db
        .prepare(
          `SELECT fv.*, ef.field_type, ef.page, ef.x, ef.y, ef.w, ef.h
           FROM field_values fv
           JOIN envelope_fields ef ON ef.id = fv.field_id AND ef.envelope_id = fv.envelope_id
           WHERE fv.envelope_id = ?`
        )
        .all(envelopeId)
    : db
        .prepare(
          `SELECT fv.*, tf.field_type, tf.page, tf.x, tf.y, tf.w, tf.h
           FROM field_values fv
           JOIN template_fields tf ON tf.id = fv.field_id
           WHERE fv.envelope_id = ?`
        )
        .all(envelopeId);
  for (const v of values) {
    if (["signature", "initials", "attachment"].includes(v.field_type)) continue;
    const pageIndex = placed.length ? Number(v.page || 0) : pageOffset + (v.page || 0);
    const page = pages[Math.min(pageIndex, pages.length - 1)];
    const text = v.field_type === "date" ? ukDate(v.value) : String(v.value || "");
    if (v.field_type === "checkbox") {
      if (text && text !== "0" && text.toLowerCase() !== "false") {
        page.drawText("X", {
          x: Number(v.x) + 2,
          y: Number(v.y) + 2,
          size: Math.min(12, Number(v.h) || 12),
          font,
          color: rgb(0.1, 0.1, 0.1),
        });
      }
      continue;
    }
    // A value stays inside its box so it never runs into the contract's own words.
    const room = Number(v.w) - 4;
    const fit = room > 0 && text ? (10 * room) / font.widthOfTextAtSize(text, 10) : 10;
    page.drawText(text, {
      x: Number(v.x) + 2,
      y: Number(v.y) + 4,
      size: Math.max(6, Math.min(10, fit)),
      font,
      color: rgb(0.1, 0.1, 0.1),
    });
  }

  const signedPdf = await PDFDocument.load(Buffer.from(await pdf.save()));
  await appendBoundAttachments(signedPdf, envelope, listSigningAttachments(envelopeId));

  const completedBytes = Buffer.from(await signedPdf.save());
  const completedFile = writeBytes(
    "completed",
    `${envelopeId}-completed.pdf`,
    completedBytes
  );
  const completedDocId = newId();
  db.prepare(
    `INSERT INTO documents (id, envelope_id, kind, storage_ref, sha256, size_bytes, created_at)
     VALUES (?, ?, 'completed', ?, ?, ?, ?)`
  ).run(
    completedDocId,
    envelopeId,
    completedFile.storageRef,
    completedFile.sha256,
    completedFile.sizeBytes,
    now()
  );

  const completedAt = now();
  db.prepare(
    "UPDATE envelopes SET status = 'completed', completed_at = ? WHERE id = ?"
  ).run(completedAt, envelopeId);

  appendEvent({
    envelopeId,
    actor: "system",
    eventType: "completed",
    metadata: {
      completed_document_id: completedDocId,
      baked_hash: envelope.baked_hash,
    },
  });
  appendEvent({
    envelopeId,
    actor: "system",
    eventType: "copies_distributed",
    metadata: { local_only: true, parties: signatures.length },
  });

  // completion emails (local log)
  const parties = db
    .prepare("SELECT * FROM envelope_parties WHERE envelope_id = ?")
    .all(envelopeId);
  for (const party of parties) {
    sendTemplatedEmail({
      entityId: entity.id,
      templateType: "completion",
      to: party.signer_email,
      envelopeId,
      partyId: party.id,
      vars: {
        signer_name: party.signer_name,
        signer_company: party.company_name,
        entity_display_name: entity.display_name,
        envelope_title: envelope.title || "Document",
        signing_link: "",
        expiry_date: "",
        role_label: "",
        declined_by: "",
        decline_reason: "",
      },
    });
  }

  return db.prepare("SELECT * FROM envelopes WHERE id = ?").get(envelopeId);
}

export { CONSENT_TEXT };

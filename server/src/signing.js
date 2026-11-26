import { createHash, randomBytes } from "node:crypto";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { db, newId, now, sha256 } from "./db.js";
import { appendEvent } from "./events.js";
import { sendTemplatedEmail } from "./mail.js";
import { readBytes, writeBytes, writeBase64Png } from "./storage.js";
import { envelopePlacedFields, fieldsForParty } from "./documentFields.js";
import { FINAL_EVIDENCE } from "./parties.js";
import { assertClientMayBeInvited, assertContractMayBeIssued } from "./dueDiligence.js";
import { SIGNATURE_MAX_HEIGHT } from "./signatureInput.js";

const CONSENT_TEXT =
  "I agree to sign this document electronically. I understand that my electronic signature is as legally binding as a handwritten signature.";

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
    templateType: envelope.status === "ready" && party.status === "pending"
      ? "invitation"
      : "turn_notification",
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

export function startSigningInvites(envelopeId, baseUrl, actor = "staff") {
  assertContractMayBeIssued(envelopeId);
  const envelope = db.prepare("SELECT * FROM envelopes WHERE id = ?").get(envelopeId);
  if (!envelope || envelope.status !== "ready") {
    throw new Error("Envelope must be ready before inviting");
  }
  if (!envelope.baked_hash) throw new Error("Envelope is not baked");

  const issuedAt = now();
  db.prepare(
    "UPDATE envelopes SET issued_at = COALESCE(issued_at, ?) WHERE id = ?"
  ).run(issuedAt, envelopeId);

  const first = getActionableParty(envelopeId);
  if (!first) throw new Error("No actionable party");
  const result = inviteParty(envelopeId, first.id, { baseUrl, actor });
  return { ...result, issuedAt };
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
      throw new Error(`Required field missing: ${field.field_key}`);
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

function pdfText(value) {
  return String(value || "").replace(/[^\x20-\x7E]/g, " ");
}

/** Signing attachments, in sign order, ready to bind after the signed contract. */
export function listSigningAttachments(envelopeId) {
  const parties = db
    .prepare(
      `SELECT p.id, p.signer_name, r.role_key, r.label AS role_label
       FROM envelope_parties p
       JOIN template_roles r ON r.id = p.role_id
       WHERE p.envelope_id = ?
       ORDER BY p.order_index ASC`
    )
    .all(envelopeId);
  const files = db
    .prepare(
      `SELECT f.*, r.requirement_key, r.label
       FROM evidence_files f
       JOIN evidence_requirements r ON r.id = f.requirement_id
       WHERE f.envelope_id = ? AND f.deleted_at IS NULL`
    )
    .all(envelopeId);
  const entries = [];
  for (const party of parties) {
    const keys = FINAL_EVIDENCE[party.role_key] || [];
    const allowed = new Set(keys.map(([key]) => key));
    const mine = files.filter(
      (file) => file.party_id === party.id && allowed.has(file.requirement_key)
    );
    const used = new Set();
    const pushFile = (file, label) => {
      used.add(file.id);
      entries.push({
        heading: `${party.role_label} - ${label}`,
        detail: `${party.signer_name} · ${file.original_name || "attachment"}`,
        bytes: readBytes(file.storage_ref),
      });
    };
    for (const [key, label] of keys) {
      const file = mine.find((row) => row.requirement_key === key);
      if (file) pushFile(file, file.label || label);
    }
    for (const file of mine) {
      if (!used.has(file.id)) pushFile(file, file.label || file.requirement_key);
    }
  }
  return entries;
}

async function drawAttachmentNote(pdf, font, bold, entry, note) {
  const page = pdf.addPage([595.28, 841.89]);
  page.drawText(pdfText(entry.heading).slice(0, 90), {
    x: 48,
    y: 780,
    size: 16,
    font: bold,
    color: rgb(0.1, 0.12, 0.16),
  });
  page.drawText(pdfText(entry.detail).slice(0, 110), {
    x: 48,
    y: 752,
    size: 11,
    font,
    color: rgb(0.2, 0.24, 0.3),
  });
  page.drawText(pdfText(note), {
    x: 48,
    y: 720,
    size: 11,
    font,
    color: rgb(0.1, 0.12, 0.16),
  });
}

/** Bind each requested attachment. */
export async function appendBoundAttachments(pdf, entries) {
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  for (const entry of entries) {
    const bytes = Buffer.from(entry.bytes);
    if (bytes.slice(0, 5).toString() === "%PDF-") {
      let src;
      try {
        src = await PDFDocument.load(bytes);
      } catch {
        await drawAttachmentNote(
          pdf,
          font,
          bold,
          entry,
          "This PDF could not be embedded. The original file is stored with the contract record."
        );
        continue;
      }
      const slip = pdf.addPage([595.28, 841.89]);
      slip.drawText(pdfText(entry.heading).slice(0, 90), {
        x: 48,
        y: 780,
        size: 16,
        font: bold,
        color: rgb(0.1, 0.12, 0.16),
      });
      slip.drawText(pdfText(entry.detail).slice(0, 110), {
        x: 48,
        y: 752,
        size: 11,
        font,
        color: rgb(0.2, 0.24, 0.3),
      });
      const copied = await pdf.copyPages(src, src.getPageIndices());
      for (const page of copied) pdf.addPage(page);
      continue;
    }
    const page = pdf.addPage([595.28, 841.89]);
    page.drawText(pdfText(entry.heading).slice(0, 90), {
      x: 48,
      y: 800,
      size: 14,
      font: bold,
      color: rgb(0.1, 0.12, 0.16),
    });
    page.drawText(pdfText(entry.detail).slice(0, 110), {
      x: 48,
      y: 778,
      size: 10,
      font,
      color: rgb(0.2, 0.24, 0.3),
    });
    const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
    const isPng =
      bytes.length >= 8 &&
      bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    if (!isJpeg && !isPng) {
      page.drawText("This file is stored with the contract record.", {
        x: 48,
        y: 740,
        size: 11,
        font,
        color: rgb(0.1, 0.12, 0.16),
      });
      continue;
    }
    const image = isJpeg ? await pdf.embedJpg(bytes) : await pdf.embedPng(bytes);
    const scale = Math.min(500 / image.width, 700 / image.height, 1);
    const width = image.width * scale;
    const height = image.height * scale;
    page.drawImage(image, { x: 48, y: 750 - height, width, height });
  }
}

export async function finalizeEnvelope(envelopeId) {
  const envelope = db.prepare("SELECT * FROM envelopes WHERE id = ?").get(envelopeId);
  const entity = db.prepare("SELECT * FROM entities WHERE id = ?").get(envelope.entity_id);
  const baked = db
    .prepare("SELECT * FROM documents WHERE id = ?")
    .get(envelope.baked_document_id);
  const bakedBytes = readBytes(baked.storage_ref);
  const pdf = await PDFDocument.load(bakedBytes);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const pages = pdf.getPages();
  const placed = envelopePlacedFields(envelopeId);
  const pageOffset = Number(envelope.contract_page_offset || 0);

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
    const text = String(v.value || "");
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
    page.drawText(text, {
      x: Number(v.x) + 2,
      y: Number(v.y) + 4,
      size: 10,
      font,
      color: rgb(0.1, 0.1, 0.1),
    });
  }

  const signedPdf = await PDFDocument.load(Buffer.from(await pdf.save()));
  await appendBoundAttachments(signedPdf, listSigningAttachments(envelopeId));

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

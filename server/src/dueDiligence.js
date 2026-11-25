import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { db, newId, now } from "./db.js";
import { appendEvent } from "./events.js";
import { readBytes, writeBase64Png, writeBytes } from "./storage.js";
import { DD_REQUIREMENTS, OFFICE_CHANGE_ITEM, PARTY_LABELS } from "./parties.js";
import { packSources } from "./partyRecords.js";
import { buildDueDiligencePdf } from "./ddPack.js";

const ACCEPTED = ["application/pdf", "image/jpeg", "image/png"];

export function ddApplies(envelope) {
  return envelope?.party_shape === "three" || envelope?.party_shape === "four";
}

export function assertDdEditable(envelope) {
  if (!ddApplies(envelope)) {
    throw new Error("This contract does not use the due diligence pack");
  }
  if (["in_progress", "completed", "declined", "voided", "expired"].includes(envelope.status)) {
    throw new Error("The due diligence pack is locked once the contract has been issued");
  }
}

function clearPartySubmission(envelopeId, roleKey) {
  db.prepare(
    `UPDATE envelope_parties
     SET dd_submitted_at = NULL
     WHERE envelope_id = ?
       AND role_id IN (SELECT id FROM template_roles WHERE role_key = ?)`
  ).run(envelopeId, roleKey);
}

function clearCompiled(envelopeId) {
  db.prepare(
    `UPDATE envelopes
     SET dd_compiled_at = NULL, dd_validated_at = NULL, dd_validated_by = NULL,
         dd_storage_ref = NULL, dd_sha256 = NULL,
         dd_signed_name = NULL, dd_signed_ip = NULL, dd_signature_ref = NULL
     WHERE id = ?`
  ).run(envelopeId);
}

function partyByRole(envelopeId) {
  const rows = db
    .prepare(
      `SELECT p.*, r.role_key, r.label AS role_label
       FROM envelope_parties p
       JOIN template_roles r ON r.id = p.role_id
       WHERE p.envelope_id = ?`
    )
    .all(envelopeId);
  return Object.fromEntries(rows.map((row) => [row.role_key, row]));
}

function latestFile(envelopeId, roleKey, requirementKey, nameChangeId, stage) {
  return db
    .prepare(
      `SELECT * FROM pack_files
       WHERE envelope_id = ? AND role_key = ? AND stage = ?
         AND requirement_key = ? AND IFNULL(name_change_id, '') = ?
       ORDER BY uploaded_at DESC LIMIT 1`
    )
    .get(envelopeId, roleKey, stage, requirementKey, nameChangeId || "");
}

function nameChanges(envelopeId, roleKey) {
  return db
    .prepare(
      `SELECT * FROM company_name_changes
       WHERE envelope_id = ? AND role_key = ?
       ORDER BY sort_index ASC, previous_name ASC`
    )
    .all(envelopeId, roleKey);
}

function officeChanged(envelopeId, roleKey) {
  const row = db
    .prepare(
      `SELECT enabled FROM dd_flags
       WHERE envelope_id = ? AND role_key = ? AND flag_key = 'office_changed'`
    )
    .get(envelopeId, roleKey);
  return Boolean(row?.enabled);
}

function sectionRoles(envelope) {
  const roles = ["supplier"];
  if (envelope.party_shape === "four") roles.push("spv");
  roles.push("company");
  return roles;
}

function itemView(envelopeId, roleKey, key, label, required) {
  const file = latestFile(envelopeId, roleKey, key, null, "dd");
  return {
    key,
    label,
    required,
    satisfied: !required || Boolean(file),
    file: file
      ? { id: file.id, original_name: file.original_name, uploaded_at: file.uploaded_at }
      : null,
  };
}

export function dueDiligenceState(envelopeId) {
  const envelope = db.prepare("SELECT * FROM envelopes WHERE id = ?").get(envelopeId);
  if (!envelope || !ddApplies(envelope)) {
    return { applies: false };
  }
  const parties = partyByRole(envelopeId);
  const sections = [];
  for (const roleKey of sectionRoles(envelope)) {
    const defs = DD_REQUIREMENTS[roleKey] || [];
    const items = defs.map(([key, label]) => itemView(envelopeId, roleKey, key, label, true));
    if (roleKey === "supplier") {
      const [key, label] = OFFICE_CHANGE_ITEM;
      const required = officeChanged(envelopeId, roleKey);
      items.push(itemView(envelopeId, roleKey, key, label, required));
    }
    const changes = nameChanges(envelopeId, roleKey).map((change) => {
      const file = latestFile(envelopeId, roleKey, "name_change", change.id, "dd");
      return {
        id: change.id,
        previous_name: change.previous_name,
        new_name: change.new_name,
        label: `Change of name (${change.previous_name} to ${change.new_name})`,
        satisfied: Boolean(file),
        file: file
          ? { id: file.id, original_name: file.original_name, uploaded_at: file.uploaded_at }
          : null,
      };
    });
    const party = parties[roleKey];
    sections.push({
      roleKey,
      label: PARTY_LABELS[roleKey] || roleKey,
      partyId: party?.id || null,
      companyName: party?.company_name || "",
      signerName: party?.signer_name || "",
      signerEmail: party?.signer_email || "",
      submittedAt: party?.dd_submitted_at || null,
      items,
      nameChanges: changes,
      officeChanged: roleKey === "supplier" ? officeChanged(envelopeId, roleKey) : false,
    });
  }
  for (const section of sections) {
    if (section.roleKey === "supplier" || section.roleKey === "spv") {
      section.heldOnRecord = true;
      section.items = [];
      section.nameChanges = [];
    }
  }
  const pack = packSources(envelopeId);
  const recordGaps = pack.missing.filter((item) => !item.includes("received and checked dates"));
  return {
    applies: true,
    shape: envelope.party_shape,
    compiledAt: envelope.dd_compiled_at || null,
    validatedAt: envelope.dd_validated_at || null,
    validatedBy: envelope.dd_validated_by || null,
    signedName: envelope.dd_signed_name || null,
    signedIp: envelope.dd_signed_ip || null,
    hasFile: Boolean(envelope.dd_storage_ref),
    readyToCompile: pack.missing.length === 0,
    allSubmitted: recordGaps.length === 0,
    missing: pack.missing,
    documents: pack.documents,
    records: pack.records,
    sections,
  };
}

export function assertDocumentUpload(file) {
  if (!file?.buffer) throw new Error("File required");
  if (file.size > 20 * 1024 * 1024) throw new Error("File too large");
  const buf = file.buffer;
  const isPdf = buf.slice(0, 5).toString() === "%PDF-";
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
  const isPng = buf.slice(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (!(isPdf || isJpeg || isPng)) {
    throw new Error("File content does not match PDF, JPEG or PNG");
  }
  return { isPdf, isJpeg, isPng };
}

function replacePackFile({
  envelopeId,
  roleKey,
  stage,
  requirementKey,
  nameChangeId,
  file,
}) {
  assertDocumentUpload(file);
  const stored = writeBytes(
    "diligence",
    `${envelopeId}-${stage}-${roleKey}-${requirementKey}-${Date.now()}`,
    file.buffer
  );
  db.prepare(
    `DELETE FROM pack_files
     WHERE envelope_id = ? AND role_key = ? AND stage = ?
       AND requirement_key = ? AND IFNULL(name_change_id, '') = ?`
  ).run(envelopeId, roleKey, stage, requirementKey, nameChangeId || "");
  const id = newId();
  db.prepare(
    `INSERT INTO pack_files (
      id, envelope_id, role_key, stage, requirement_key, name_change_id,
      original_name, mime, size_bytes, storage_ref, file_hash, uploaded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    envelopeId,
    roleKey,
    stage,
    requirementKey,
    nameChangeId || null,
    file.originalname || "document",
    file.mimetype || "application/octet-stream",
    file.size,
    stored.storageRef,
    stored.sha256,
    now()
  );
  return { id, sha256: stored.sha256, original_name: file.originalname };
}

export function saveDueDiligenceFile(envelopeId, {
  roleKey,
  requirementKey,
  nameChangeId,
  file,
  partyId = null,
}) {
  const envelope = db.prepare("SELECT * FROM envelopes WHERE id = ?").get(envelopeId);
  assertDdEditable(envelope);
  const stateRoles = new Set(sectionRoles(envelope));
  if (!stateRoles.has(roleKey)) throw new Error("That party is not on this contract");
  if (nameChangeId) {
    const change = db
      .prepare(
        "SELECT * FROM company_name_changes WHERE id = ? AND envelope_id = ? AND role_key = ?"
      )
      .get(nameChangeId, envelopeId, roleKey);
    if (!change) throw new Error("Unknown name change");
    requirementKey = "name_change";
  } else if (requirementKey === "registered_office") {
    if (roleKey !== "supplier" || !officeChanged(envelopeId, roleKey)) {
      throw new Error("Registered office evidence is only requested when the office has changed");
    }
  } else {
    const known = (DD_REQUIREMENTS[roleKey] || []).some(([key]) => key === requirementKey);
    if (!known) throw new Error("Unknown due diligence document");
  }
  const saved = replacePackFile({
    envelopeId,
    roleKey,
    stage: "dd",
    requirementKey,
    nameChangeId,
    file,
  });
  clearPartySubmission(envelopeId, roleKey);
  clearCompiled(envelopeId);
  appendEvent({
    envelopeId,
    partyId,
    actor: partyId ? "party" : "staff",
    eventType: "dd_file_uploaded",
    metadata: {
      role_key: roleKey,
      requirement_key: requirementKey,
      name_change_id: nameChangeId || null,
      original_name: saved.original_name,
      file_hash: saved.sha256,
    },
  });
  return dueDiligenceState(envelopeId);
}

export function addNameChange(envelopeId, { roleKey, previousName, newName, partyId = null }) {
  const envelope = db.prepare("SELECT * FROM envelopes WHERE id = ?").get(envelopeId);
  assertDdEditable(envelope);
  if (!sectionRoles(envelope).includes(roleKey)) {
    throw new Error("Name changes are recorded for the contractor, supplier and client");
  }
  const previous = String(previousName || "").trim();
  const next = String(newName || "").trim();
  if (!previous || !next) throw new Error("Enter the previous name and the new name");
  const sort = nameChanges(envelopeId, roleKey).length;
  db.prepare(
    `INSERT INTO company_name_changes (
      id, envelope_id, role_key, previous_name, new_name, sort_index
    ) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(newId(), envelopeId, roleKey, previous, next, sort);
  clearPartySubmission(envelopeId, roleKey);
  clearCompiled(envelopeId);
  appendEvent({
    envelopeId,
    partyId,
    actor: partyId ? "party" : "staff",
    eventType: "dd_name_change_added",
    metadata: { role_key: roleKey, previous_name: previous, new_name: next },
  });
  return dueDiligenceState(envelopeId);
}

export function removeNameChange(envelopeId, changeId) {
  const envelope = db.prepare("SELECT * FROM envelopes WHERE id = ?").get(envelopeId);
  assertDdEditable(envelope);
  const change = db
    .prepare("SELECT * FROM company_name_changes WHERE id = ? AND envelope_id = ?")
    .get(changeId, envelopeId);
  if (!change) throw new Error("Name change not found");
  db.prepare("DELETE FROM pack_files WHERE name_change_id = ?").run(changeId);
  db.prepare("DELETE FROM company_name_changes WHERE id = ?").run(changeId);
  clearPartySubmission(envelopeId, change.role_key);
  clearCompiled(envelopeId);
  return dueDiligenceState(envelopeId);
}

export function setOfficeChanged(envelopeId, enabled) {
  const envelope = db.prepare("SELECT * FROM envelopes WHERE id = ?").get(envelopeId);
  assertDdEditable(envelope);
  db.prepare(
    `INSERT INTO dd_flags (envelope_id, role_key, flag_key, enabled)
     VALUES (?, 'supplier', 'office_changed', ?)
     ON CONFLICT (envelope_id, role_key, flag_key)
     DO UPDATE SET enabled = excluded.enabled`
  ).run(envelopeId, enabled ? 1 : 0);
  clearPartySubmission(envelopeId, "supplier");
  clearCompiled(envelopeId);
  return dueDiligenceState(envelopeId);
}

function packEntries(envelopeId) {
  const envelope = db.prepare("SELECT * FROM envelopes WHERE id = ?").get(envelopeId);
  const state = dueDiligenceState(envelopeId);
  const entries = [];
  for (const section of state.sections) {
    for (const item of section.items) {
      if (!item.file) continue;
      if (item.key === "registered_office" && !section.officeChanged) continue;
      const row = latestFile(envelopeId, section.roleKey, item.key, null, "dd");
      if (row) entries.push({ ...row, heading: `${section.label} — ${item.label}` });
    }
    for (const change of section.nameChanges) {
      const row = latestFile(envelopeId, section.roleKey, "name_change", change.id, "dd");
      if (row) entries.push({ ...row, heading: `${section.label} — ${change.label}` });
    }
  }
  return { envelope, entries };
}

function pdfText(value) {
  return String(value || "").replace(/[^\x20-\x7E]/g, " ");
}

function wrap(text, width) {
  const words = String(text || "").split(/\s+/);
  const lines = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > width) {
      if (current) lines.push(current);
      current = word;
    } else current = next;
  }
  if (current) lines.push(current);
  return lines;
}

export async function compileDueDiligence(envelopeId, actor = "staff") {
  const envelope = db.prepare("SELECT * FROM envelopes WHERE id = ?").get(envelopeId);
  assertDdEditable(envelope);
  const state = dueDiligenceState(envelopeId);
  if (!state.readyToCompile) {
    throw new Error(`Due diligence is incomplete: ${state.missing.join("; ")}`);
  }
  const out = await buildDueDiligencePdf(envelopeId);
  const stored = writeBytes("diligence", `${envelopeId}-due-diligence.pdf`, out);
  const stamped = now();
  db.prepare(
    `UPDATE envelopes
     SET dd_compiled_at = ?, dd_storage_ref = ?, dd_sha256 = ?,
         dd_validated_at = NULL, dd_validated_by = NULL,
         dd_signed_name = NULL, dd_signed_ip = NULL, dd_signature_ref = NULL
     WHERE id = ?`
  ).run(stamped, stored.storageRef, stored.sha256, envelopeId);
  appendEvent({
    envelopeId,
    actor,
    eventType: "dd_compiled",
    metadata: { file_hash: stored.sha256, documents: state.documents.length },
  });
  return dueDiligenceState(envelopeId);
}

export function submitDueDiligence(envelopeId, roleKey, partyId = null) {
  const envelope = db.prepare("SELECT * FROM envelopes WHERE id = ?").get(envelopeId);
  assertDdEditable(envelope);
  const state = dueDiligenceState(envelopeId);
  const section = state.sections.find((item) => item.roleKey === roleKey);
  if (!section?.partyId) throw new Error("This party does not supply due diligence documents");
  const missing = [
    ...section.items.filter((item) => item.required && !item.file).map((item) => item.label),
    ...section.nameChanges.filter((change) => !change.file).map((change) => change.label),
  ];
  if (missing.length) throw new Error(`Still needed: ${missing.join("; ")}`);
  const stamped = now();
  db.prepare("UPDATE envelope_parties SET dd_submitted_at = ? WHERE id = ?").run(
    stamped,
    section.partyId
  );
  appendEvent({
    envelopeId,
    partyId: partyId || section.partyId,
    actor: "party",
    eventType: "dd_submitted",
    metadata: { role_key: roleKey },
  });
  return dueDiligenceState(envelopeId);
}

const DD_CONSENT =
  "I have checked the contents of this due diligence pack and I am satisfied with it.";

export async function signDueDiligence(envelopeId, {
  partyId,
  signatureDataUrl,
  typedName,
  ip,
  userAgent,
}) {
  const envelope = db.prepare("SELECT * FROM envelopes WHERE id = ?").get(envelopeId);
  assertDdEditable(envelope);
  if (!envelope.dd_storage_ref || !envelope.dd_compiled_at) {
    throw new Error("The due diligence pack is not ready to sign");
  }
  if (envelope.dd_validated_at) {
    throw new Error("The broker has already signed this due diligence pack");
  }
  const party = db.prepare("SELECT * FROM envelope_parties WHERE id = ?").get(partyId);
  const role = db.prepare("SELECT * FROM template_roles WHERE id = ?").get(party?.role_id);
  if (!party || party.envelope_id !== envelopeId || role?.role_key !== "agency") {
    throw new Error("Only the broker signs the due diligence pack");
  }
  if (!String(signatureDataUrl || "").startsWith("data:image/png")) {
    throw new Error("Draw your signature");
  }
  const signerName = String(typedName || party.signer_name || "").trim();
  if (!signerName) throw new Error("Enter the name you are signing with");

  const sigFile = writeBase64Png("signatures", `dd-${envelopeId}-${Date.now()}.png`, signatureDataUrl);
  const pdf = await PDFDocument.load(readBytes(envelope.dd_storage_ref));
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const page = pdf.addPage([595, 842]);
  const signedAt = now();
  page.drawText("Broker signature", {
    x: 48,
    y: 780,
    size: 18,
    font: bold,
    color: rgb(0, 0.45, 1),
  });
  let textY = 744;
  for (const statement of wrap(DD_CONSENT, 78)) {
    page.drawText(pdfText(statement), {
      x: 48,
      y: textY,
      size: 12,
      font,
      color: rgb(0.1, 0.12, 0.16),
    });
    textY -= 18;
  }
  const image = await pdf.embedPng(readBytes(sigFile.storageRef));
  const scale = Math.min(240 / image.width, 90 / image.height, 1);
  page.drawImage(image, {
    x: 48,
    y: 620,
    width: image.width * scale,
    height: image.height * scale,
  });
  page.drawText(pdfText(`Signed by ${signerName}`), {
    x: 48,
    y: 590,
    size: 12,
    font: bold,
    color: rgb(0.1, 0.12, 0.16),
  });
  page.drawText(pdfText(`${party.company_name} · ${party.signer_email}`), {
    x: 48,
    y: 570,
    size: 11,
    font,
    color: rgb(0.1, 0.12, 0.16),
  });
  page.drawText(pdfText(`Date ${signedAt.slice(0, 10)} · Signed ${signedAt} · IP ${ip || "—"}`), {
    x: 48,
    y: 550,
    size: 11,
    font,
    color: rgb(0.1, 0.12, 0.16),
  });

  const out = Buffer.from(await pdf.save());
  const stored = writeBytes("diligence", `${envelopeId}-due-diligence.pdf`, out);
  db.prepare(
    `UPDATE envelopes
     SET dd_validated_at = ?, dd_validated_by = ?, dd_signed_name = ?,
         dd_signed_ip = ?, dd_signature_ref = ?, dd_storage_ref = ?, dd_sha256 = ?
     WHERE id = ?`
  ).run(
    signedAt,
    partyId,
    signerName,
    ip || null,
    sigFile.storageRef,
    stored.storageRef,
    stored.sha256,
    envelopeId
  );
  appendEvent({
    envelopeId,
    partyId,
    actor: "party",
    eventType: "dd_signed",
    metadata: { file_hash: stored.sha256, signer_name: signerName },
    ip,
    userAgent,
  });
  return dueDiligenceState(envelopeId);
}

export function diligenceSession(partyId) {
  const party = db.prepare("SELECT * FROM envelope_parties WHERE id = ?").get(partyId);
  if (!party) throw new Error("Unknown party");
  const role = db.prepare("SELECT * FROM template_roles WHERE id = ?").get(party.role_id);
  const envelope = db.prepare("SELECT * FROM envelopes WHERE id = ?").get(party.envelope_id);
  const state = dueDiligenceState(envelope.id);
  if (!state.applies) throw new Error("This contract does not use a due diligence pack");
  const editable = !["in_progress", "completed", "declined", "voided", "expired"].includes(
    envelope.status
  );
  const session = {
    mode: role.role_key === "agency" ? "sign" : "upload",
    editable,
    envelope: { id: envelope.id, title: envelope.title || "Contract", status: envelope.status },
    party: {
      id: party.id,
      role_key: role.role_key,
      role_label: role.label || PARTY_LABELS[role.role_key] || role.role_key,
      signer_name: party.signer_name,
      signer_email: party.signer_email,
      company_name: party.company_name,
    },
    compiled: Boolean(state.compiledAt),
    signed: Boolean(state.validatedAt),
    signedAt: state.validatedAt,
    signedName: state.signedName,
    consent: DD_CONSENT,
  };
  if (session.mode === "upload") {
    const section = state.sections.find((item) => item.roleKey === role.role_key);
    if (!section) throw new Error("This party does not supply due diligence documents");
    session.section = section;
  }
  return session;
}

export function readDueDiligence(envelopeId) {
  const envelope = db.prepare("SELECT * FROM envelopes WHERE id = ?").get(envelopeId);
  if (!envelope?.dd_storage_ref) return null;
  return readBytes(envelope.dd_storage_ref);
}

export function assertContractMayBeIssued(envelopeId) {
  const envelope = db.prepare("SELECT * FROM envelopes WHERE id = ?").get(envelopeId);
  if (!ddApplies(envelope)) return;
  if (!envelope.dd_validated_at) {
    throw new Error(
      "The broker must sign the due diligence pack before this contract is issued"
    );
  }
}

export function assertClientMayBeInvited(envelopeId) {
  const envelope = db.prepare("SELECT * FROM envelopes WHERE id = ?").get(envelopeId);
  if (!ddApplies(envelope)) return;
  if (!envelope.dd_validated_at) {
    throw new Error(
      "The broker must sign the due diligence pack before the contract is sent to the client"
    );
  }
}

export { ACCEPTED };

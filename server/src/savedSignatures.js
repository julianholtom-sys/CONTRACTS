import fs from "node:fs";
import { db, now } from "./db.js";
import { missingPartyDetails } from "./documentFields.js";
import { FINAL_EVIDENCE, PARTY_LABELS, SIGN_ORDER, SIGNS_BY_LINK } from "./parties.js";
import { readSignatureInput } from "./signatureInput.js";
import { absolutePath, exists, readBytes, writeBase64Png } from "./storage.js";

/** Company record kind for each party that signs with a saved signature. */
export const RECORD_KIND = { agency: "broker", supplier: "contractor", spv: "supplier" };
const SAVED_SIGNATURE_KINDS = new Set(Object.values(RECORD_KIND));
const SAVED_METHODS = new Set(["typed", "uploaded"]);

export function sameSigner(a, b) {
  const clean = (name) => String(name || "").replace(/\s+/g, " ").trim().toLowerCase();
  return clean(a) === clean(b);
}

export function signatureView(row) {
  if (!row?.signature_ref) return null;
  return {
    method: row.signature_method,
    text: row.signature_text || "",
    saved_at: row.signature_saved_at,
    url: `/api/parties/${row.id}/signature?v=${encodeURIComponent(row.signature_saved_at || "")}`,
  };
}

function recordRow(id) {
  return db.prepare("SELECT * FROM directory_parties WHERE id = ?").get(id);
}

function removeStored(storageRef) {
  if (!storageRef) return;
  try {
    fs.unlinkSync(absolutePath(storageRef));
  } catch {
    /* already gone */
  }
}

/** Typed in a handwriting font or an uploaded image, kept on the contractor, supplier or broker record. */
export function savePartySignature(partyId, input = {}) {
  const row = recordRow(partyId);
  if (!row || !SAVED_SIGNATURE_KINDS.has(row.kind)) throw new Error("Company record not found");
  const { dataUrl, method } = readSignatureInput(input);
  if (!SAVED_METHODS.has(input.method)) throw new Error("Type the name or upload an image of the signature");
  const stored = writeBase64Png("signatures", `record-${partyId}-${Date.now()}.png`, dataUrl);
  removeStored(row.signature_ref);
  db.prepare(
    `UPDATE directory_parties
     SET signature_ref = ?, signature_method = ?, signature_text = ?, signature_saved_at = ?
     WHERE id = ?`
  ).run(
    stored.storageRef,
    method,
    method === "typed" ? String(input.typedName || "").trim().slice(0, 80) : "",
    now(),
    partyId
  );
  return recordRow(partyId);
}

/** A saved signature belongs to the person named on the record. */
export function dropSignatureIfSignerChanged(row, signerName) {
  if (!row?.signature_ref || sameSigner(row.signer_name, signerName)) return;
  removeStored(row.signature_ref);
  db.prepare(
    `UPDATE directory_parties
     SET signature_ref = NULL, signature_method = NULL, signature_text = NULL, signature_saved_at = NULL
     WHERE id = ?`
  ).run(row.id);
}

export function readPartySignature(partyId) {
  const row = recordRow(partyId);
  if (!row?.signature_ref || !exists(row.signature_ref)) return null;
  return readBytes(row.signature_ref);
}

export function savedSignatureDataUrl(row) {
  if (!row?.signature_ref || !exists(row.signature_ref)) return null;
  return `data:image/png;base64,${readBytes(row.signature_ref).toString("base64")}`;
}

/** The broker's own signatory record, found from the broker the contract is sent for. */
export function brokerRecord(entityId) {
  if (!entityId) return null;
  return db
    .prepare("SELECT * FROM directory_parties WHERE kind = 'broker' AND entity_id = ? ORDER BY created_at LIMIT 1")
    .get(entityId);
}

export function recordForEnvelopeParty(envelope, party) {
  const kind = RECORD_KIND[party.role_key];
  if (!kind) return null;
  const linked = party.directory_party_id ? recordRow(party.directory_party_id) : null;
  if (linked?.kind === kind) return linked;
  if (kind === "broker") return brokerRecord(envelope.entity_id);
  return (
    db
      .prepare(
        "SELECT * FROM directory_parties WHERE kind = ? AND lower(trim(company_name)) = lower(trim(?)) ORDER BY created_at DESC LIMIT 1"
      )
      .get(kind, party.company_name) || null
  );
}

/** Every party except the client, in sign order: Contractor, Supplier (4-way), Broker. */
export function partiesSigningInApp(envelopeId) {
  return db
    .prepare(
      `SELECT p.*, r.role_key, r.label AS role_label, r.evidence_required
       FROM envelope_parties p JOIN template_roles r ON r.id = p.role_id
       WHERE p.envelope_id = ? AND r.role_key != ?
       ORDER BY p.order_index`
    )
    .all(envelopeId, SIGNS_BY_LINK)
    .sort((a, b) => SIGN_ORDER.indexOf(a.role_key) - SIGN_ORDER.indexOf(b.role_key));
}

export function directorIdRequirement(party) {
  if (!party.evidence_required) return null;
  if (!(FINAL_EVIDENCE[party.role_key] || []).some(([key]) => key === "director_id")) return null;
  return (
    db
      .prepare("SELECT * FROM evidence_requirements WHERE role_id = ? AND requirement_key = 'director_id'")
      .get(party.role_id) || null
  );
}

export function directorIdFile(recordId) {
  return db
    .prepare(
      "SELECT * FROM party_files WHERE party_id = ? AND source = 'upload' AND requirement_key = 'director_id' ORDER BY created_at DESC LIMIT 1"
    )
    .get(recordId);
}

/** What stops the contractor, supplier and broker signing with their saved signatures, in sign order. */
export function savedSignatureGaps(envelopeId) {
  const envelope = db.prepare("SELECT id, entity_id FROM envelopes WHERE id = ?").get(envelopeId);
  if (!envelope) return [];
  const gaps = [];
  for (const party of partiesSigningInApp(envelopeId)) {
    if (party.status === "completed") continue;
    const kind = RECORD_KIND[party.role_key];
    const record = recordForEnvelopeParty(envelope, party);
    const href = kind === "broker" ? `/brokers/${envelope.entity_id}` : record ? `/${kind}s/${record.id}` : `/${kind}s`;
    const add = (text) =>
      gaps.push({ roleKey: party.role_key, label: PARTY_LABELS[party.role_key] || party.role_label, text, href });
    if (!record) {
      add(kind === "broker" ? "add who signs for the broker" : `save ${party.company_name} as a ${kind}`);
      continue;
    }
    if (!sameSigner(record.signer_name, party.signer_name)) {
      add(`the contract names ${party.signer_name}; the company record names ${record.signer_name}`);
    } else if (!record.signature_ref || !exists(record.signature_ref)) {
      add(`add ${record.signer_name}’s signature`);
    }
    if (directorIdRequirement(party)?.is_required && !directorIdFile(record.id)) add("add the director ID");
    // Only the client fills in boxes by hand, so everyone else's must come from their records.
    for (const detail of missingPartyDetails(envelopeId, party.role_id)) add(`add the ${detail}; the contract asks for it`);
  }
  return gaps;
}

export function gapMessage(gaps) {
  return `Before sending: ${gaps.map((gap) => `${gap.label}: ${gap.text}`).join("; ")}`;
}

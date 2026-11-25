import fs from "node:fs";
import { db, newId, now } from "./db.js";
import { PARTY_LABELS, PARTY_UPLOADS } from "./parties.js";
import { downloadFiling, fetchCompanyRecord, filingLabel, normaliseCompanyNumber } from "./companiesHouse.js";
import { screenNames } from "./sanctions.js";
import { absolutePath, writeBytes } from "./storage.js";

function roleLabel(role) {
  return role === "authorised_signatory" ? "Authorised signatory" : "Director";
}

const KIND_FOR_ROLE = { supplier: "contractor", spv: "supplier" };
const ROLE_FOR_KIND = { contractor: "supplier", supplier: "spv" };

function partyRow(id) {
  return db.prepare("SELECT * FROM directory_parties WHERE id = ?").get(id);
}

function registryRow(partyId) {
  return db.prepare("SELECT * FROM party_registry WHERE party_id = ?").get(partyId) || null;
}

function filesFor(partyId) {
  return db
    .prepare("SELECT * FROM party_files WHERE party_id = ? ORDER BY created_at ASC")
    .all(partyId);
}

function publicFile(file) {
  if (!file) return null;
  return {
    id: file.id,
    source: file.source,
    requirement_key: file.requirement_key,
    label: file.label,
    original_name: file.original_name,
    mime: file.mime,
    created_at: file.created_at,
  };
}

export function serializeRecord(row) {
  if (!row) return null;
  const registry = registryRow(row.id);
  const files = filesFor(row.id);
  const uploads = PARTY_UPLOADS[row.kind] || [];
  const uploadViews = uploads.map(([key, label]) => {
    const file = [...files].reverse().find((item) => item.source === "upload" && item.requirement_key === key);
    return { key, label, file: publicFile(file) };
  });
  let sanctions = null;
  if (registry?.sanctions_json) {
    try {
      sanctions = JSON.parse(registry.sanctions_json);
    } catch {
      sanctions = null;
    }
  }
  return {
    id: row.id,
    kind: row.kind,
    company_name: row.company_name,
    company_number: row.company_number || "",
    signer_name: row.signer_name,
    signer_role: row.signer_role,
    signer_role_label: roleLabel(row.signer_role),
    signer_email: row.signer_email,
    is_sample: Boolean(row.is_sample),
    registry: registry
      ? {
          legal_name: registry.legal_name || "",
          status: registry.status || "",
          incorporated_on: registry.incorporated_on || "",
          registered_office: registry.registered_office || "",
          company_type: registry.company_type || "",
          fetched_at: registry.fetched_at || null,
          error: registry.error || "",
          officerCount: safeCount(registry.officers_json),
          pscCount: safeCount(registry.psc_json),
          sanctions: sanctions
            ? {
                listedOn: sanctions.listedOn || "",
                searchedAt: sanctions.searchedAt || "",
                hitCount: sanctions.hitCount || 0,
                hits: sanctions.hits || [],
              }
            : null,
        }
      : null,
    companiesHouseFiles: files.filter((file) => file.source === "companies_house").map(publicFile),
    uploads: uploadViews,
    uploadsComplete: uploadViews.every((item) => item.file),
  };
}

function safeCount(json) {
  try {
    const value = JSON.parse(json || "[]");
    return Array.isArray(value) ? value.length : 0;
  } catch {
    return 0;
  }
}

export function listPartyRecords(kind) {
  if (kind !== "contractor" && kind !== "supplier") throw new Error("Choose a contractor or a supplier");
  return db
    .prepare("SELECT * FROM directory_parties WHERE kind = ? ORDER BY company_name")
    .all(kind)
    .map(serializeRecord);
}

export function getPartyRecord(id) {
  const row = partyRow(id);
  if (!row || (row.kind !== "contractor" && row.kind !== "supplier")) {
    throw new Error("Company record not found");
  }
  return serializeRecord(row);
}

export function savePartyRecord(kind, input) {
  if (kind !== "contractor" && kind !== "supplier") {
    throw new Error("Documents are added on a contractor or a supplier");
  }
  const companyName = String(input.company_name || "").trim();
  const signerName = String(input.signer_name || "").trim();
  const signerRole = String(input.signer_role || "director").trim();
  const signerEmail = String(input.signer_email || "").trim();
  const companyNumber = input.company_number ? normaliseCompanyNumber(input.company_number) : "";
  if (!companyName) throw new Error("Company name is required");
  if (!signerName) throw new Error("Signatory is required");
  if (!["director", "authorised_signatory"].includes(signerRole)) {
    throw new Error("Role must be director, or authorised signatory");
  }
  if (!signerEmail.includes("@")) throw new Error("A valid email is required");
  if (input.id) {
    const existing = partyRow(input.id);
    if (!existing || existing.kind !== kind) throw new Error("Company record not found");
    db.prepare(
      `UPDATE directory_parties
       SET company_name = ?, company_number = ?, signer_name = ?, signer_role = ?, signer_email = ?
       WHERE id = ?`
    ).run(companyName, companyNumber, signerName, signerRole, signerEmail, existing.id);
    return serializeRecord(partyRow(existing.id));
  }
  const id = newId();
  db.prepare(
    `INSERT INTO directory_parties (
      id, kind, company_name, company_number, signer_name, signer_role, signer_email, entity_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`
  ).run(id, kind, companyName, companyNumber, signerName, signerRole, signerEmail, now());
  return serializeRecord(partyRow(id));
}

function removeStored(file) {
  try {
    fs.unlinkSync(absolutePath(file.storage_ref));
  } catch {
    /* already gone */
  }
}

export async function refreshPartyRegistry(partyId) {
  const party = partyRow(partyId);
  if (!party) throw new Error("Company record not found");
  if (!party.company_number) throw new Error("Add the company number first");
  const number = normaliseCompanyNumber(party.company_number);
  const record = await fetchCompanyRecord(number);
  let sanctions = null;
  let sanctionsError = "";
  try {
    sanctions = await screenNames({
      companyName: record.profile.legalName || party.company_name,
      companyNumber: number,
      people: [...record.officers, ...record.pscs],
    });
  } catch (err) {
    sanctionsError = err.message;
  }

  const previous = db
    .prepare("SELECT * FROM party_files WHERE party_id = ? AND source = 'companies_house'")
    .all(partyId);
  for (const file of previous) removeStored(file);
  db.prepare("DELETE FROM party_files WHERE party_id = ? AND source = 'companies_house'").run(partyId);

  const failures = [];
  for (const filing of record.filings) {
    try {
      const bytes = await downloadFiling(filing.pdfUrl);
      const stored = writeBytes("registry", `${partyId}-${filing.type}-${storedName(filing)}.pdf`, bytes);
      db.prepare(
        `INSERT INTO party_files (
          id, party_id, source, requirement_key, label, original_name, mime, storage_ref, file_hash, created_at
        ) VALUES (?, ?, 'companies_house', ?, ?, ?, 'application/pdf', ?, ?, ?)`
      ).run(
        newId(),
        partyId,
        filing.key,
        `${filingLabel(filing.key)} — ${filing.date || filing.type}`,
        filing.description || `${filing.type}.pdf`,
        stored.storageRef,
        stored.sha256,
        now()
      );
    } catch (err) {
      failures.push(`${filing.type}: ${err.message}`);
    }
  }

  const error = [sanctionsError, ...failures].filter(Boolean).join("; ");
  db.prepare(
    `INSERT INTO party_registry (
      party_id, company_number, legal_name, status, incorporated_on, registered_office, company_type,
      profile_json, officers_json, psc_json, sanctions_json, fetched_at, error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(party_id) DO UPDATE SET
      company_number = excluded.company_number,
      legal_name = excluded.legal_name,
      status = excluded.status,
      incorporated_on = excluded.incorporated_on,
      registered_office = excluded.registered_office,
      company_type = excluded.company_type,
      profile_json = excluded.profile_json,
      officers_json = excluded.officers_json,
      psc_json = excluded.psc_json,
      sanctions_json = excluded.sanctions_json,
      fetched_at = excluded.fetched_at,
      error = excluded.error`
  ).run(
    partyId,
    number,
    record.profile.legalName || party.company_name,
    record.profile.status,
    record.profile.incorporatedOn,
    record.profile.registeredOffice,
    record.profile.companyType,
    JSON.stringify(record.profile),
    JSON.stringify(record.officers),
    JSON.stringify(record.pscs),
    sanctions ? JSON.stringify(sanctions) : null,
    now(),
    error
  );
  if (record.profile.legalName && record.profile.legalName !== party.company_name) {
    db.prepare("UPDATE directory_parties SET company_name = ?, company_number = ? WHERE id = ?").run(
      record.profile.legalName,
      number,
      partyId
    );
  } else {
    db.prepare("UPDATE directory_parties SET company_number = ? WHERE id = ?").run(number, partyId);
  }
  return getPartyRecord(partyId);
}

function storedName(filing) {
  return `${filing.date || "filing"}`.replace(/[^\w]+/g, "").slice(0, 24);
}

export function savePartyUpload(partyId, requirementKey, file) {
  const party = partyRow(partyId);
  if (!party) throw new Error("Company record not found");
  const allowed = PARTY_UPLOADS[party.kind] || [];
  const match = allowed.find(([key]) => key === requirementKey);
  if (!match) throw new Error("That document is not requested for this company");
  if (!file?.buffer?.length) throw new Error("Choose a file");
  const mime = file.mimetype || "application/octet-stream";
  if (!["application/pdf", "image/jpeg", "image/png"].includes(mime)) {
    throw new Error("Upload a PDF or an image");
  }
  const previous = db
    .prepare(
      "SELECT * FROM party_files WHERE party_id = ? AND source = 'upload' AND requirement_key = ?"
    )
    .all(partyId, requirementKey);
  for (const old of previous) removeStored(old);
  db.prepare(
    "DELETE FROM party_files WHERE party_id = ? AND source = 'upload' AND requirement_key = ?"
  ).run(partyId, requirementKey);
  const stored = writeBytes("registry", `${partyId}-${requirementKey}-${file.originalname || "file"}`, file.buffer);
  db.prepare(
    `INSERT INTO party_files (
      id, party_id, source, requirement_key, label, original_name, mime, storage_ref, file_hash, created_at
    ) VALUES (?, ?, 'upload', ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    newId(),
    partyId,
    requirementKey,
    match[1],
    file.originalname || match[1],
    mime,
    stored.storageRef,
    stored.sha256,
    now()
  );
  return getPartyRecord(partyId);
}

export function readPartyFile(partyId, fileId) {
  const file = db
    .prepare("SELECT * FROM party_files WHERE id = ? AND party_id = ?")
    .get(fileId, partyId);
  if (!file) return null;
  return file;
}

function directoryForEnvelopeParty(party) {
  if (party?.directory_party_id) {
    const linked = partyRow(party.directory_party_id);
    if (linked) return linked;
  }
  const kind = KIND_FOR_ROLE[party?.role_key];
  if (!kind || !party?.company_name) return null;
  return (
    db
      .prepare(
        `SELECT * FROM directory_parties
         WHERE kind = ? AND lower(company_name) = lower(?)
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(kind, party.company_name) || null
  );
}

function checksFor(envelopeId) {
  const rows = db.prepare("SELECT * FROM envelope_doc_checks WHERE envelope_id = ?").all(envelopeId);
  return Object.fromEntries(rows.map((row) => [row.doc_key, row]));
}

export function packSources(envelopeId) {
  const envelope = db.prepare("SELECT * FROM envelopes WHERE id = ?").get(envelopeId);
  const parties = db
    .prepare(
      `SELECT p.*, r.role_key
       FROM envelope_parties p
       JOIN template_roles r ON r.id = p.role_id
       WHERE p.envelope_id = ?`
    )
    .all(envelopeId);
  const byRole = Object.fromEntries(parties.map((party) => [party.role_key, party]));
  const documents = [];
  const missing = [];
  const records = [];
  const roles = envelope?.party_shape === "four" ? ["supplier", "spv"] : ["supplier"];
  for (const roleKey of roles) {
    const party = byRole[roleKey];
    const kind = KIND_FOR_ROLE[roleKey];
    const label = PARTY_LABELS[roleKey] || roleKey;
    if (!party) {
      missing.push(`${label} is missing from this contract`);
      continue;
    }
    const record = directoryForEnvelopeParty({ ...party, role_key: roleKey });
    const href = record ? `/${kind === "contractor" ? "contractors" : "suppliers"}/${record.id}` : "";
    if (!record) {
      missing.push(`Save ${party.company_name || label} as a ${kind} and add the company number`);
      records.push({ roleKey, label, companyName: party.company_name, directoryId: null, href });
      continue;
    }
    records.push({
      roleKey,
      label,
      companyName: record.company_name,
      directoryId: record.id,
      companyNumber: record.company_number || "",
      href,
    });
    const registry = registryRow(record.id);
    if (!record.company_number) {
      missing.push(`${label}: add the company number`);
    } else if (!registry?.fetched_at) {
      missing.push(`${label}: fetch Companies House`);
    }
    const files = filesFor(record.id);
    for (const file of files.filter((item) => item.source === "companies_house")) {
      documents.push(docFromFile(roleKey, label, record, file));
    }
    if (registry?.officers_json) {
      documents.push({
        key: `officers:${record.id}`,
        roleKey,
        roleLabel: label,
        companyName: record.company_name,
        label: "Director details from Companies House",
        source: "companies_house",
        virtual: "officers",
        partyId: record.id,
      });
    }
    if (registry?.sanctions_json) {
      documents.push({
        key: `sanctions:${record.id}`,
        roleKey,
        roleLabel: label,
        companyName: record.company_name,
        label: "UK Sanctions List search",
        source: "sanctions",
        virtual: "sanctions",
        partyId: record.id,
      });
    }
    for (const [key, uploadLabel] of PARTY_UPLOADS[kind] || []) {
      const file = [...files].reverse().find((item) => item.source === "upload" && item.requirement_key === key);
      if (!file) {
        missing.push(`${label}: ${uploadLabel}`);
        continue;
      }
      documents.push(docFromFile(roleKey, label, record, file));
    }
  }
  const saved = checksFor(envelopeId);
  for (const doc of documents) {
    const check = saved[doc.key];
    doc.receivedOn = check?.received_on || "";
    doc.checkedOn = check?.checked_on || "";
    if (!doc.receivedOn || !doc.checkedOn) {
      missing.push(`${doc.roleLabel}: received and checked dates for ${doc.label}`);
    }
  }
  return { documents, missing, records, byRole };
}

function docFromFile(roleKey, label, record, file) {
  return {
    key: `file:${file.id}`,
    roleKey,
    roleLabel: label,
    companyName: record.company_name,
    label: file.label,
    source: file.source,
    fileId: file.id,
    partyId: record.id,
    originalName: file.original_name,
    mime: file.mime,
    storageRef: file.storage_ref,
  };
}

export function saveDocChecks(envelopeId, checks) {
  if (!Array.isArray(checks)) throw new Error("Add a received date and a checked date for each document");
  const current = packSources(envelopeId);
  const allowed = new Set(current.documents.map((doc) => doc.key));
  const upsert = db.prepare(
    `INSERT INTO envelope_doc_checks (envelope_id, doc_key, received_on, checked_on)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(envelope_id, doc_key) DO UPDATE SET
       received_on = excluded.received_on,
       checked_on = excluded.checked_on`
  );
  for (const check of checks) {
    if (!allowed.has(check.key)) continue;
    const received = String(check.receivedOn || "").trim();
    const checked = String(check.checkedOn || "").trim();
    if (received && !/^\d{4}-\d{2}-\d{2}$/.test(received)) {
      throw new Error("Received date must be a calendar date");
    }
    if (checked && !/^\d{4}-\d{2}-\d{2}$/.test(checked)) {
      throw new Error("Checked date must be a calendar date");
    }
    upsert.run(envelopeId, check.key, received || null, checked || null);
  }
  return packSources(envelopeId);
}

export function registryBundle(partyId) {
  const registry = registryRow(partyId);
  if (!registry) return null;
  return {
    profile: parseJson(registry.profile_json, {}),
    officers: parseJson(registry.officers_json, []),
    pscs: parseJson(registry.psc_json, []),
    sanctions: parseJson(registry.sanctions_json, null),
  };
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function roleKind(roleKey) {
  return KIND_FOR_ROLE[roleKey] || null;
}

export function kindRole(kind) {
  return ROLE_FOR_KIND[kind] || null;
}

import { db, newId, now, sha256 } from "./db.js";
import { detectPdfFields, ROLE_LABELS } from "./detectFields.js";
import { brokerLegalName } from "./packLayout.js";

function roleIdsForTemplate(templateId) {
  const rows = db
    .prepare("SELECT id, role_key FROM template_roles WHERE template_id = ?")
    .all(templateId);
  const map = {};
  for (const row of rows) map[row.role_key] = row.id;
  return map;
}

function insertTemplateField(templateId, roleId, field) {
  db.prepare(
    `INSERT INTO template_fields (
      id, template_id, role_id, field_key, label, field_type, required,
      page, x, y, w, h, validation_json
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, NULL)`
  ).run(
    newId(),
    templateId,
    roleId,
    field.field_key,
    field.label,
    field.field_type,
    field.page || 0,
    field.x,
    field.y,
    field.w,
    field.h
  );
}

export function ensureStoredDateFields(templateId) {
  const roles = db.prepare("SELECT * FROM template_roles WHERE template_id = ?").all(templateId);
  let added = 0;
  for (const role of roles) {
    const existing = db
      .prepare(
        `SELECT id FROM template_fields
         WHERE template_id = ? AND role_id = ? AND field_type = 'date'`
      )
      .get(templateId, role.id);
    const signature = db
      .prepare(
        `SELECT * FROM template_fields
         WHERE template_id = ? AND role_id = ? AND field_type = 'signature'
         ORDER BY page, y LIMIT 1`
      )
      .get(templateId, role.id);
    if (!signature) {
      db.prepare(
        `DELETE FROM template_fields
         WHERE template_id = ? AND role_id = ? AND field_type = 'date' AND field_key = ?`
      ).run(templateId, role.id, `${role.role_key}_date`);
      continue;
    }
    if (existing) continue;
    insertTemplateField(templateId, role.id, {
      field_key: `${role.role_key}_date`,
      label: `${role.label || role.role_key} date`,
      field_type: "date",
      page: signature?.page || 0,
      x: Math.min(Number(signature?.x || 50) + Number(signature?.w || 180) + 16, 450),
      y: signature?.y || 80,
      w: 110,
      h: 18,
    });
    added += 1;
  }
  return added;
}

const FALLBACK_MASTER_FIELDS = [
  { role: "company", field_key: "company_sig", label: "Client signature", field_type: "signature", page: 0, x: 50, y: 190, w: 180, h: 36 },
  { role: "company", field_key: "company_date", label: "Client date", field_type: "date", page: 0, x: 250, y: 198, w: 120, h: 20 },
  { role: "agency", field_key: "agency_sig", label: "Broker signature", field_type: "signature", page: 0, x: 50, y: 120, w: 180, h: 36 },
  { role: "agency", field_key: "agency_date", label: "Broker date", field_type: "date", page: 0, x: 250, y: 128, w: 120, h: 20 },
  { role: "supplier", field_key: "supplier_sig", label: "Contractor signature", field_type: "signature", page: 0, x: 50, y: 50, w: 180, h: 36 },
  { role: "supplier", field_key: "supplier_date", label: "Contractor date", field_type: "date", page: 0, x: 250, y: 58, w: 120, h: 20 },
  { role: "spv", field_key: "spv_sig", label: "Supplier signature", field_type: "signature", page: 0, x: 50, y: 260, w: 180, h: 36 },
  { role: "spv", field_key: "spv_date", label: "Supplier date", field_type: "date", page: 0, x: 250, y: 268, w: 120, h: 20 },
];

export function insertFallbackMasterFields(templateId) {
  const roleIds = roleIdsForTemplate(templateId);
  for (const field of FALLBACK_MASTER_FIELDS) {
    if (!roleIds[field.role]) continue;
    insertTemplateField(templateId, roleIds[field.role], field);
  }
}

/** Templates still on the fallback fields predate the Supplier (SPV) role, so they lack its block. */
export function ensureFallbackSupplierFields(templateId) {
  const keys = new Set(FALLBACK_MASTER_FIELDS.map((field) => field.field_key));
  const fields = db
    .prepare("SELECT field_key FROM template_fields WHERE template_id = ?")
    .all(templateId);
  if (!fields.length || !fields.every((field) => keys.has(field.field_key))) return 0;
  const roleIds = roleIdsForTemplate(templateId);
  if (!roleIds.spv) return 0;
  const present = new Set(fields.map((field) => field.field_key));
  let added = 0;
  for (const field of FALLBACK_MASTER_FIELDS.filter((item) => item.role === "spv")) {
    if (present.has(field.field_key)) continue;
    insertTemplateField(templateId, roleIds.spv, field);
    added += 1;
  }
  return added;
}

export function replaceTemplateFields(templateId, detected) {
  const roleIds = roleIdsForTemplate(templateId);
  db.prepare("DELETE FROM template_fields WHERE template_id = ?").run(templateId);
  for (const field of detected) {
    const roleId = roleIds[field.role_key];
    if (!roleId) continue;
    insertTemplateField(templateId, roleId, field);
  }
}

export async function applyMasterPdfFields(templateId, pdfBytes, { isNew = false } = {}) {
  const detected = await detectPdfFields(pdfBytes, { kind: "master" });
  const existing = db
    .prepare("SELECT COUNT(*) AS n FROM template_fields WHERE template_id = ?")
    .get(templateId).n;
  if (detected.length) {
    replaceTemplateFields(templateId, detected);
    ensureStoredDateFields(templateId);
    return { found: detected.length, replaced: true };
  }
  if (isNew && !existing) {
    insertFallbackMasterFields(templateId);
    ensureStoredDateFields(templateId);
    return { found: 0, replaced: false, fallback: true };
  }
  ensureStoredDateFields(templateId);
  return { found: 0, replaced: false, kept_existing: Boolean(existing) };
}

export async function applyAppendixPdfFields(appendixId, pdfBytes) {
  const detected = await detectPdfFields(pdfBytes, { kind: "appendix" });
  db.prepare("DELETE FROM appendix_fields WHERE appendix_id = ?").run(appendixId);
  for (const field of detected) {
    db.prepare(
      `INSERT INTO appendix_fields (
        id, appendix_id, role_key, field_key, label, field_type, required,
        page, x, y, w, h
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`
    ).run(
      newId(),
      appendixId,
      field.role_key,
      field.field_key,
      field.label,
      field.field_type,
      field.page || 0,
      field.x,
      field.y,
      field.w,
      field.h
    );
  }
  return { found: detected.length };
}

export function listAppendixFields(appendixId) {
  return db
    .prepare(
      "SELECT * FROM appendix_fields WHERE appendix_id = ? ORDER BY page, y DESC, x"
    )
    .all(appendixId);
}

export function snapshotEnvelopeFields(envelopeId, { contractPageOffset, masterPageMap = [], appendixStarts }) {
  db.prepare("DELETE FROM envelope_fields WHERE envelope_id = ?").run(envelopeId);
  const envelope = db.prepare("SELECT * FROM envelopes WHERE id = ?").get(envelopeId);
  const templateId =
    envelope.template_id ||
    db
      .prepare(
        `SELECT r.template_id FROM envelope_parties p
         JOIN template_roles r ON r.id = p.role_id
         WHERE p.envelope_id = ? LIMIT 1`
      )
      .get(envelopeId)?.template_id;
  const roleRows = db
    .prepare("SELECT id, role_key FROM template_roles WHERE template_id = ?")
    .all(templateId);
  const roleByKey = Object.fromEntries(roleRows.map((r) => [r.role_key, r.id]));

  const masterFields = db
    .prepare("SELECT * FROM template_fields WHERE template_id = ?")
    .all(templateId);
  for (const field of masterFields) {
    db.prepare(
      `INSERT INTO envelope_fields (
        id, envelope_id, role_id, source, appendix_id, field_key, label, field_type,
        required, page, x, y, w, h
      ) VALUES (?, ?, ?, 'master', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      field.id,
      envelopeId,
      field.role_id,
      field.field_key,
      field.label,
      field.field_type,
      field.required,
      masterPageMap[field.page || 0] ?? (contractPageOffset || 0) + (field.page || 0),
      field.x,
      field.y,
      field.w,
      field.h
    );
  }

  for (const start of appendixStarts || []) {
    const rows = listAppendixFields(start.id);
    for (const field of rows) {
      const roleId = roleByKey[field.role_key];
      if (!roleId) continue;
      db.prepare(
        `INSERT INTO envelope_fields (
          id, envelope_id, role_id, source, appendix_id, field_key, label, field_type,
          required, page, x, y, w, h
        ) VALUES (?, ?, ?, 'appendix', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        field.id,
        envelopeId,
        roleId,
        start.id,
        field.field_key,
        field.label,
        field.field_type,
        field.required,
        start.pageIndex + (field.page || 0),
        field.x,
        field.y,
        field.w,
        field.h
      );
    }
  }
}

const DETAIL_NAMES = {
  company_name: "company name",
  company_number: "company number",
  registered_office: "registered office",
  signer_name: "signatory’s name",
};

function detailKeyFor(label) {
  const text = String(label || "").toLowerCase().trim();
  if (/company (number|no)|registration number|registered number/.test(text)) return "company_number";
  if (/registered office|registered address|\baddress\b/.test(text)) return "registered_office";
  if (/company name|registered name|trading name/.test(text)) return "company_name";
  if (/print name|printed name|full name|name of signatory|signer'?s name|^name:?$|^guarantor director\b/.test(text)) return "signer_name";
  if (/position|job title|capacity|\btitle\b/.test(text)) return "signer_role";
  return null;
}

function partyValueFor(label, party) {
  const key = detailKeyFor(label);
  if (key === "signer_role") return party.signer_role === "authorised_signatory" ? "Authorised signatory" : "Director";
  return key ? party[key] : "";
}

/**
 * Each party as its detail boxes are filled: the record's Companies House details stand in for a
 * missing registered office or number, and the broker is named by its own legal details.
 */
function contractPartyDetails(envelopeId) {
  const envelope = db.prepare("SELECT entity_id FROM envelopes WHERE id = ?").get(envelopeId);
  const broker = envelope
    ? db
        .prepare("SELECT legal_name, display_name, company_number, registered_office FROM entities WHERE id = ?")
        .get(envelope.entity_id)
    : null;
  return db
    .prepare(
      `SELECT p.*, r.role_key, pr.registered_office AS registry_office, pr.company_number AS registry_number
       FROM envelope_parties p
       JOIN template_roles r ON r.id = p.role_id
       LEFT JOIN party_registry pr ON pr.party_id = p.directory_party_id
       WHERE p.envelope_id = ?`
    )
    .all(envelopeId)
    .map((party) => {
      const details = {
        ...party,
        registered_office: party.registered_office || party.registry_office || "",
        company_number: party.company_number || party.registry_number || "",
      };
      if (party.role_key === "agency" && broker?.legal_name) {
        details.company_name = brokerLegalName(broker);
        details.company_number = broker.company_number || details.company_number;
        details.registered_office = broker.registered_office || details.registered_office;
      }
      return details;
    });
}

/** Details a party's boxes on the contract ask for that its records don't hold. */
export function missingPartyDetails(envelopeId, roleId) {
  const party = contractPartyDetails(envelopeId).find((row) => row.role_id === roleId);
  if (!party) return [];
  const missing = new Set();
  for (const field of fieldsForParty(envelopeId, roleId)) {
    if (field.field_type !== "text") continue;
    const key = detailKeyFor(field.label);
    if (DETAIL_NAMES[key] && !String(party[key] || "").trim()) missing.add(DETAIL_NAMES[key]);
  }
  return [...missing];
}

/** Fills each party's detail boxes from what the contract already knows; the signer can still change them. */
export function prefillPartyFields(envelopeId) {
  const parties = contractPartyDetails(envelopeId);
  const filled = new Set(
    db.prepare("SELECT field_id FROM field_values WHERE envelope_id = ?").all(envelopeId).map((row) => row.field_id)
  );
  const fields = db
    .prepare("SELECT * FROM envelope_fields WHERE envelope_id = ? AND field_type = 'text'")
    .all(envelopeId);
  let added = 0;
  for (const field of fields) {
    if (filled.has(field.id)) continue;
    const party = parties.find((row) => row.role_id === field.role_id);
    const value = party ? String(partyValueFor(field.label, party) || "").trim() : "";
    if (!value) continue;
    db.prepare(
      `INSERT INTO field_values (
        id, envelope_id, field_id, party_id, value, value_hash, captured_at, captured_ip
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`
    ).run(newId(), envelopeId, field.id, party.id, value, sha256(value), now());
    added += 1;
  }
  return added;
}

export function fieldsForParty(envelopeId, roleId) {
  const placed = db
    .prepare(
      `SELECT ef.*, a.name AS appendix_name
       FROM envelope_fields ef
       LEFT JOIN appendices a ON a.id = ef.appendix_id
       WHERE ef.envelope_id = ? AND ef.role_id = ?
       ORDER BY ef.page ASC, ef.y DESC, ef.x ASC`
    )
    .all(envelopeId, roleId);
  if (placed.length) {
    return placed.map((field) => withJumpMeta(field));
  }
  const envelope = db.prepare("SELECT * FROM envelopes WHERE id = ?").get(envelopeId);
  const offset = Number(envelope?.contract_page_offset || 0);
  return db
    .prepare("SELECT * FROM template_fields WHERE role_id = ?")
    .all(roleId)
    .map((field) =>
      withJumpMeta({
        ...field,
        source: "master",
        appendix_id: null,
        appendix_name: null,
        page: offset + (field.page || 0),
      })
    );
}

export function getSignField(envelopeId, fieldId, roleId) {
  const placed = db
    .prepare(
      "SELECT * FROM envelope_fields WHERE envelope_id = ? AND id = ?"
    )
    .get(envelopeId, fieldId);
  if (placed) return placed;
  return db.prepare("SELECT * FROM template_fields WHERE id = ? AND role_id = ?").get(fieldId, roleId);
}

export function withJumpMeta(field) {
  const bakedPage = Number(field.page || 0);
  const sourceLabel =
    field.source === "appendix"
      ? field.appendix_name || "Appendix"
      : "Master contract";
  return {
    ...field,
    baked_page: bakedPage,
    jump_page: bakedPage + 1,
    source_label: sourceLabel,
    role_label: ROLE_LABELS[field.role_key] || field.role_label || null,
  };
}

export function envelopePlacedFields(envelopeId) {
  return db
    .prepare("SELECT * FROM envelope_fields WHERE envelope_id = ?")
    .all(envelopeId);
}

import { db, newId } from "./db.js";
import { detectPdfFields, ROLE_LABELS } from "./detectFields.js";

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

export function insertFallbackMasterFields(templateId) {
  const roleIds = roleIdsForTemplate(templateId);
  const fields = [
    { role: "company", field_key: "company_sig", label: "Client signature", field_type: "signature", page: 0, x: 50, y: 190, w: 180, h: 36 },
    { role: "company", field_key: "company_date", label: "Client date", field_type: "date", page: 0, x: 250, y: 198, w: 120, h: 20 },
    { role: "agency", field_key: "agency_sig", label: "Broker signature", field_type: "signature", page: 0, x: 50, y: 120, w: 180, h: 36 },
    { role: "agency", field_key: "agency_date", label: "Broker date", field_type: "date", page: 0, x: 250, y: 128, w: 120, h: 20 },
    { role: "supplier", field_key: "supplier_sig", label: "Contractor signature", field_type: "signature", page: 0, x: 50, y: 50, w: 180, h: 36 },
    { role: "supplier", field_key: "supplier_date", label: "Contractor date", field_type: "date", page: 0, x: 250, y: 58, w: 120, h: 20 },
    { role: "spv", field_key: "spv_sig", label: "Supplier signature", field_type: "signature", page: 0, x: 50, y: 260, w: 180, h: 36 },
    { role: "spv", field_key: "spv_date", label: "Supplier date", field_type: "date", page: 0, x: 250, y: 268, w: 120, h: 20 },
  ];
  for (const field of fields) {
    if (!roleIds[field.role]) continue;
    insertTemplateField(templateId, roleIds[field.role], field);
  }
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

export function snapshotEnvelopeFields(envelopeId, { contractPageOffset, appendixStarts }) {
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
      (contractPageOffset || 0) + (field.page || 0),
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

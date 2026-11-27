import { db, newId, now } from "./db.js";
import { getMasterTemplate } from "./bake.js";
import { applyAppendixPdfFields, applyMasterPdfFields, listAppendixFields, replaceTemplateFields } from "./documentFields.js";
import { isWordFile } from "./docxTemplate.js";
import { ensureSigningEvidence } from "./seed.js";
import { writeBytes } from "./storage.js";
import { previewWordTemplate, wordContractNeeds } from "./wordContract.js";

/** The contracts a broker offers. Both 3-way types have the Contractor, Broker and Client; the 4-way adds the Supplier. */
export const CONTRACT_TYPES = [
  { key: "three_lower", label: "3-way lower", shape: "three" },
  { key: "three_higher", label: "3-way higher", shape: "three" },
  { key: "four", label: "4-way", shape: "four" },
];
const TYPE_BY_KEY = Object.fromEntries(CONTRACT_TYPES.map((type) => [type.key, type]));
const ALL_TYPES = CONTRACT_TYPES.map((type) => type.key);

const ROLES = [
  ["supplier", "Contractor", 1],
  ["spv", "Supplier (SPV)", 2],
  ["agency", "Broker", 3],
  ["company", "Client", 4],
];

export function contractTypeLabel(key) {
  return TYPE_BY_KEY[key]?.label || "";
}

export function contractType(key) {
  const type = TYPE_BY_KEY[key];
  if (!type) throw new Error("Choose 3-way lower, 3-way higher or 4-way");
  return type;
}

/** The types a schedule is used on, as stored: null when it is used on every type. */
export function storedScheduleTypes(value) {
  const listed = Array.isArray(value) ? value : String(value ?? "").split(",");
  const keys = ALL_TYPES.filter((key) => listed.map((item) => String(item).trim()).includes(key));
  if (!keys.length) throw new Error("Tick at least one contract type for this schedule");
  return keys.length === ALL_TYPES.length ? null : keys.join(",");
}

function requireBroker(entityId) {
  const entity = db.prepare("SELECT id, display_name FROM entities WHERE id = ? AND is_active = 1").get(entityId);
  if (!entity) throw new Error("Unknown broker");
  return entity;
}

function requirePdf(file) {
  if (!file?.buffer?.length) throw new Error("PDF file required");
  if (file.buffer.subarray(0, 5).toString() !== "%PDF-") throw new Error("That file is not a PDF");
}

function fileName(ref) {
  return String(ref || "").replace(/^local:\/\//, "").split(/[/\\]/).pop() || "";
}

export function brokerMaster(entityId, typeKey) {
  return (
    db
      .prepare(
        `SELECT * FROM templates
         WHERE is_master = 1 AND is_active = 1 AND entity_id = ? AND contract_type = ?
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(entityId, typeKey) || null
  );
}

/** The broker's own contract of that type, or the shared placeholder until one is uploaded. */
export function contractTemplateFor(entityId, typeKey) {
  return brokerMaster(entityId, typeKey) || getMasterTemplate() || null;
}

export function masterView(template) {
  if (!template) return null;
  return {
    id: template.id,
    name: template.name,
    description: template.description || "",
    party_shape: template.party_shape || null,
    contract_type: template.contract_type || null,
    entity_id: template.entity_id || null,
    is_placeholder: !template.entity_id,
    file_name: fileName(template.docx_ref || template.source_url),
    is_word: Boolean(template.docx_ref),
    needs: wordContractNeeds(template),
    roles: db
      .prepare("SELECT * FROM template_roles WHERE template_id = ? ORDER BY signing_order")
      .all(template.id),
    fields: db.prepare("SELECT * FROM template_fields WHERE template_id = ?").all(template.id),
  };
}

export function brokerSchedules(entityId, typeKey = null) {
  return db
    .prepare(
      `SELECT * FROM appendices
       WHERE is_active = 1 AND entity_id = ?
         AND (? IS NULL OR contract_types IS NULL OR instr(',' || contract_types || ',', ',' || ? || ',') > 0)
       ORDER BY name`
    )
    .all(entityId, typeKey, typeKey);
}

export function scheduleView(row) {
  const fields = listAppendixFields(row.id);
  return {
    id: row.id,
    entity_id: row.entity_id,
    name: row.name,
    description: row.description || "",
    contract_types: row.contract_types ? row.contract_types.split(",") : ALL_TYPES,
    file_name: fileName(row.storage_ref),
    fields,
    needs_signing: fields.length > 0,
  };
}

export function brokerContracts(entityId) {
  requireBroker(entityId);
  return {
    entity_id: entityId,
    types: CONTRACT_TYPES,
    masters: Object.fromEntries(CONTRACT_TYPES.map((type) => [type.key, masterView(brokerMaster(entityId, type.key))])),
    placeholder: masterView(getMasterTemplate()),
    schedules: brokerSchedules(entityId).map(scheduleView),
  };
}

/**
 * A broker's contract of one type, as a PDF (fields found from its labels) or as a Word file filled
 * per contract (fields from its {{sig.*}} merge fields; the PDF kept is its preview).
 */
export async function saveBrokerMaster(entityId, typeKey, file, { name, description } = {}) {
  const type = contractType(typeKey);
  const entity = requireBroker(entityId);
  const word = isWordFile(file?.buffer || Buffer.alloc(0));
  if (!word) requirePdf(file);
  const stamp = `master-${type.key}-${Date.now()}`;
  let sourceRef;
  let docxRef = null;
  let wordFields = null;
  if (word) {
    const preview = await previewWordTemplate(file.buffer);
    const missing = ["company", "agency", "supplier"].filter(
      (role) => !preview.fields.some((field) => field.role_key === role && field.field_type === "signature")
    );
    if (type.shape === "four" && !preview.fields.some((field) => field.role_key === "spv" && field.field_type === "signature")) {
      missing.push("spv");
    }
    if (missing.length) {
      const names = { company: "Client", agency: "Broker", supplier: "Contractor", spv: "Supplier" };
      throw new Error(`This Word contract has no signature field for: ${missing.map((role) => names[role]).join(", ")}`);
    }
    docxRef = writeBytes("uploads", `${stamp}-${file.originalname}`, file.buffer).storageRef;
    sourceRef = writeBytes("uploads", `${stamp}-preview.pdf`, preview.pdf).storageRef;
    wordFields = preview.fields;
  } else {
    sourceRef = writeBytes("uploads", `${stamp}-${file.originalname}`, file.buffer).storageRef;
  }
  const applyFields = async (templateId, isNew) => {
    if (!wordFields) return applyMasterPdfFields(templateId, file.buffer, { isNew });
    replaceTemplateFields(templateId, wordFields);
    return { found: wordFields.length, replaced: true };
  };
  const existing = brokerMaster(entityId, type.key);
  if (existing) {
    db.prepare(
      `UPDATE templates SET source_url = ?, docx_ref = ?, name = COALESCE(?, name),
         description = COALESCE(?, description) WHERE id = ?`
    ).run(`local://${sourceRef}`, docxRef, name || null, description || null, existing.id);
    await applyFields(existing.id, false);
    return masterView(brokerMaster(entityId, type.key));
  }
  const id = newId();
  db.prepare(
    `INSERT INTO templates (
      id, entity_id, name, source_url, default_front_cover, default_back_cover,
      is_active, created_at, industry, description, is_master, party_shape, contract_type, docx_ref
    ) VALUES (?, ?, ?, ?, NULL, NULL, 1, ?, NULL, ?, 1, ?, ?, ?)`
  ).run(
    id,
    entityId,
    name || (word ? wordTitle(file.originalname) : "Master Services Agreement"),
    `local://${sourceRef}`,
    now(),
    description || `${entity.display_name} ${type.label} contract`,
    type.shape,
    type.key,
    docxRef
  );
  for (const [key, label, order] of ROLES) {
    db.prepare(
      `INSERT INTO template_roles (id, template_id, role_key, label, signing_order, evidence_required)
       VALUES (?, ?, ?, ?, ?, 0)`
    ).run(newId(), id, key, label, order);
  }
  ensureSigningEvidence();
  await applyFields(id, true);
  return masterView(brokerMaster(entityId, type.key));
}

/** "Union_Payroll_TOB_2026_UN-HS_1.6.docx" → "Union Payroll TOB 2026 UN-HS 1.6". */
function wordTitle(fileName) {
  return String(fileName || "Contract").replace(/\.docx$/i, "").replace(/_/g, " ").trim() || "Contract";
}

export function updateBrokerMaster(entityId, typeKey, { name, description } = {}) {
  const type = contractType(typeKey);
  const template = brokerMaster(entityId, type.key);
  if (!template) throw new Error(`No ${type.label} contract for this broker yet`);
  db.prepare("UPDATE templates SET name = ?, description = ? WHERE id = ?").run(
    String(name ?? template.name).trim() || template.name,
    description ?? template.description,
    template.id
  );
  return masterView(brokerMaster(entityId, type.key));
}

export function deleteBrokerMaster(entityId, typeKey) {
  const type = contractType(typeKey);
  const template = brokerMaster(entityId, type.key);
  if (!template) throw new Error(`No ${type.label} contract for this broker yet`);
  db.prepare("UPDATE templates SET is_active = 0 WHERE id = ?").run(template.id);
}

export async function addSchedule(entityId, { name, description, types } = {}, file) {
  requireBroker(entityId);
  const title = String(name || "").trim();
  if (!title) throw new Error("Give the schedule a name");
  requirePdf(file);
  const contractTypes = types === undefined ? null : storedScheduleTypes(types);
  const stored = writeBytes("uploads", `schedule-${Date.now()}-${file.originalname}`, file.buffer);
  const id = newId();
  db.prepare(
    `INSERT INTO appendices (
      id, entity_id, industry, name, description, storage_ref, is_active, created_at, contract_types
    ) VALUES (?, ?, '', ?, ?, ?, 1, ?, ?)`
  ).run(id, entityId, title, description || null, stored.storageRef, now(), contractTypes);
  await applyAppendixPdfFields(id, file.buffer);
  return scheduleView(db.prepare("SELECT * FROM appendices WHERE id = ?").get(id));
}

/** Schedule ids as chosen for a contract, each one this broker's and used on that type. */
export function schedulesForContract(entityId, typeKey, ids) {
  const type = contractType(typeKey);
  const wanted = Array.isArray(ids) ? [...new Set(ids.filter(Boolean))] : [];
  const allowed = new Map(brokerSchedules(entityId, type.key).map((row) => [row.id, row]));
  for (const id of wanted) {
    if (!allowed.has(id)) throw new Error(`That schedule is not one of this broker’s ${type.label} schedules`);
  }
  return wanted.map((id) => allowed.get(id));
}

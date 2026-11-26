import { db, newId, now } from "./db.js";
import { getMasterTemplate } from "./bake.js";
import { applyAppendixPdfFields, applyMasterPdfFields, listAppendixFields } from "./documentFields.js";
import { ensureSigningEvidence } from "./seed.js";
import { writeBytes } from "./storage.js";

export const SHAPES = ["three", "four"];
const SHAPE_LABEL = { three: "3-way", four: "4-way" };

const ROLES = [
  ["supplier", "Contractor", 1],
  ["spv", "Supplier (SPV)", 2],
  ["agency", "Broker", 3],
  ["company", "Client", 4],
];

function assertShape(shape) {
  if (!SHAPES.includes(shape)) throw new Error("Choose 3-way or 4-way");
}

/** "three", "four", or null for a schedule used on both. */
export function scheduleShape(value) {
  return SHAPES.includes(value) ? value : null;
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

export function brokerMaster(entityId, shape) {
  return (
    db
      .prepare(
        `SELECT * FROM templates
         WHERE is_master = 1 AND is_active = 1 AND entity_id = ? AND party_shape = ?
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(entityId, shape) || null
  );
}

/** The broker's own contract for that shape, or the shared placeholder until one is uploaded. */
export function contractTemplateFor(entityId, shape) {
  return brokerMaster(entityId, shape) || getMasterTemplate() || null;
}

export function masterView(template) {
  if (!template) return null;
  return {
    id: template.id,
    name: template.name,
    description: template.description || "",
    party_shape: template.party_shape || null,
    entity_id: template.entity_id || null,
    is_placeholder: !template.entity_id,
    file_name: fileName(template.source_url),
    roles: db
      .prepare("SELECT * FROM template_roles WHERE template_id = ? ORDER BY signing_order")
      .all(template.id),
    fields: db.prepare("SELECT * FROM template_fields WHERE template_id = ?").all(template.id),
  };
}

export function brokerSchedules(entityId, shape = null) {
  return db
    .prepare(
      `SELECT * FROM appendices
       WHERE is_active = 1 AND entity_id = ?
         AND (? IS NULL OR party_shape IS NULL OR party_shape = ?)
       ORDER BY name`
    )
    .all(entityId, shape, shape);
}

export function scheduleView(row) {
  const fields = listAppendixFields(row.id);
  return {
    id: row.id,
    entity_id: row.entity_id,
    name: row.name,
    description: row.description || "",
    party_shape: row.party_shape || null,
    file_name: fileName(row.storage_ref),
    fields,
    needs_signing: fields.length > 0,
  };
}

export function brokerContracts(entityId) {
  requireBroker(entityId);
  return {
    entity_id: entityId,
    masters: Object.fromEntries(SHAPES.map((shape) => [shape, masterView(brokerMaster(entityId, shape))])),
    placeholder: masterView(getMasterTemplate()),
    schedules: brokerSchedules(entityId).map(scheduleView),
  };
}

export async function saveBrokerMaster(entityId, shape, file, { name, description } = {}) {
  assertShape(shape);
  const entity = requireBroker(entityId);
  requirePdf(file);
  const stored = writeBytes("uploads", `master-${shape}-${Date.now()}-${file.originalname}`, file.buffer);
  const existing = brokerMaster(entityId, shape);
  if (existing) {
    db.prepare(
      "UPDATE templates SET source_url = ?, name = COALESCE(?, name), description = COALESCE(?, description) WHERE id = ?"
    ).run(`local://${stored.storageRef}`, name || null, description || null, existing.id);
    await applyMasterPdfFields(existing.id, file.buffer, { isNew: false });
    return masterView(brokerMaster(entityId, shape));
  }
  const id = newId();
  db.prepare(
    `INSERT INTO templates (
      id, entity_id, name, source_url, default_front_cover, default_back_cover,
      is_active, created_at, industry, description, is_master, party_shape
    ) VALUES (?, ?, ?, ?, NULL, NULL, 1, ?, NULL, ?, 1, ?)`
  ).run(
    id,
    entityId,
    name || "Master Services Agreement",
    `local://${stored.storageRef}`,
    now(),
    description || `${entity.display_name} ${SHAPE_LABEL[shape]} contract`,
    shape
  );
  for (const [key, label, order] of ROLES) {
    db.prepare(
      `INSERT INTO template_roles (id, template_id, role_key, label, signing_order, evidence_required)
       VALUES (?, ?, ?, ?, ?, 0)`
    ).run(newId(), id, key, label, order);
  }
  ensureSigningEvidence();
  await applyMasterPdfFields(id, file.buffer, { isNew: true });
  return masterView(brokerMaster(entityId, shape));
}

export function updateBrokerMaster(entityId, shape, { name, description } = {}) {
  assertShape(shape);
  const template = brokerMaster(entityId, shape);
  if (!template) throw new Error(`No ${SHAPE_LABEL[shape]} contract for this broker yet`);
  db.prepare("UPDATE templates SET name = ?, description = ? WHERE id = ?").run(
    String(name ?? template.name).trim() || template.name,
    description ?? template.description,
    template.id
  );
  return masterView(brokerMaster(entityId, shape));
}

export function deleteBrokerMaster(entityId, shape) {
  assertShape(shape);
  const template = brokerMaster(entityId, shape);
  if (!template) throw new Error(`No ${SHAPE_LABEL[shape]} contract for this broker yet`);
  db.prepare("UPDATE templates SET is_active = 0 WHERE id = ?").run(template.id);
}

export async function addSchedule(entityId, { name, description, shape } = {}, file) {
  requireBroker(entityId);
  const title = String(name || "").trim();
  if (!title) throw new Error("Give the schedule a name");
  requirePdf(file);
  const stored = writeBytes("uploads", `schedule-${Date.now()}-${file.originalname}`, file.buffer);
  const id = newId();
  db.prepare(
    `INSERT INTO appendices (
      id, entity_id, industry, name, description, storage_ref, is_active, created_at, party_shape
    ) VALUES (?, ?, '', ?, ?, ?, 1, ?, ?)`
  ).run(id, entityId, title, description || null, stored.storageRef, now(), scheduleShape(shape));
  await applyAppendixPdfFields(id, file.buffer);
  return scheduleView(db.prepare("SELECT * FROM appendices WHERE id = ?").get(id));
}

/** Schedule ids as chosen for a contract, each one this broker's and fit for the shape. */
export function schedulesForContract(entityId, shape, ids) {
  const wanted = Array.isArray(ids) ? [...new Set(ids.filter(Boolean))] : [];
  const allowed = new Map(brokerSchedules(entityId, shape).map((row) => [row.id, row]));
  for (const id of wanted) {
    if (!allowed.has(id)) throw new Error(`That schedule is not one of this broker’s ${SHAPE_LABEL[shape]} schedules`);
  }
  return wanted.map((id) => allowed.get(id));
}

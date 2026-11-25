import { db, newId, now } from "./db.js";
import { ensureStoredDateFields } from "./documentFields.js";
import { resolveBrandPack } from "./bake.js";

const ROLES = new Set(["director", "authorised_signatory"]);
const KINDS = new Set(["broker", "contractor", "client", "supplier"]);

export function roleLabel(role) {
  return role === "authorised_signatory" ? "Authorised signatory" : "Director";
}

function cleanParty(input, kind) {
  const companyName = String(input?.company_name || input?.companyName || "").trim();
  const signerName = String(input?.signer_name || input?.signerName || "").trim();
  const signerRole = String(input?.signer_role || input?.signerRole || "").trim();
  const signerEmail = String(input?.signer_email || input?.signerEmail || "").trim();
  const entityId = input?.entity_id || input?.entityId || null;
  const companyNumber = String(input?.company_number || input?.companyNumber || "").trim();
  if (!KINDS.has(kind)) throw new Error("Unknown directory kind");
  if (!companyName) throw new Error("Company name is required");
  if (!signerName) throw new Error("Signee name is required");
  if (!ROLES.has(signerRole)) {
    throw new Error("Role must be director, or authorised signatory if they are not a director");
  }
  if (!signerEmail || !signerEmail.includes("@")) throw new Error("A valid email is required");
  return { companyName, signerName, signerRole, signerEmail, entityId, companyNumber };
}

export function listDirectory(kind) {
  const rows = kind
    ? db.prepare("SELECT * FROM directory_parties WHERE kind = ? ORDER BY company_name, signer_name").all(kind)
    : db.prepare("SELECT * FROM directory_parties ORDER BY kind, company_name, signer_name").all();
  return rows.map(serializeParty);
}

function serializeParty(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    company_name: row.company_name,
    company_number: row.company_number || "",
    signer_name: row.signer_name,
    signer_role: row.signer_role,
    signer_role_label: roleLabel(row.signer_role),
    signer_email: row.signer_email,
    entity_id: row.entity_id || null,
    is_sample: Boolean(row.is_sample),
  };
}

export function saveBrokerSignatory(entityId, input) {
  const entity = db.prepare("SELECT * FROM entities WHERE id = ? AND is_active = 1").get(entityId);
  if (!entity) throw new Error("Broker not found");
  const party = cleanParty(
    {
      ...input,
      company_name: input?.company_name || entity.display_name,
      entityId,
    },
    "broker"
  );
  const existing = input?.id
    ? db.prepare("SELECT * FROM directory_parties WHERE id = ? AND kind = 'broker'").get(input.id)
    : db
        .prepare(
          "SELECT * FROM directory_parties WHERE kind = 'broker' AND entity_id = ? ORDER BY created_at LIMIT 1"
        )
        .get(entityId);
  if (existing) {
    db.prepare(
      `UPDATE directory_parties
       SET company_name = ?, signer_name = ?, signer_role = ?, signer_email = ?, entity_id = ?
       WHERE id = ?`
    ).run(
      party.companyName,
      party.signerName,
      party.signerRole,
      party.signerEmail,
      entityId,
      existing.id
    );
    return serializeParty(db.prepare("SELECT * FROM directory_parties WHERE id = ?").get(existing.id));
  }
  const id = newId();
  db.prepare(
    `INSERT INTO directory_parties (
      id, kind, company_name, signer_name, signer_role, signer_email, entity_id, created_at
    ) VALUES (?, 'broker', ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    party.companyName,
    party.signerName,
    party.signerRole,
    party.signerEmail,
    entityId,
    now()
  );
  return serializeParty(db.prepare("SELECT * FROM directory_parties WHERE id = ?").get(id));
}

export function saveDirectoryParty(input, kind) {
  if (input?.id) {
    const existing = db.prepare("SELECT * FROM directory_parties WHERE id = ? AND kind = ?").get(input.id, kind);
    if (!existing) throw new Error("Directory record not found");
    return serializeParty(existing);
  }
  const party = cleanParty(input, kind);
  if (kind === "broker" && !party.entityId) {
    throw new Error("A broker is tied to a sending company so the cover can be chosen");
  }
  const id = newId();
  db.prepare(
    `INSERT INTO directory_parties (
      id, kind, company_name, company_number, signer_name, signer_role, signer_email, entity_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    kind,
    party.companyName,
    party.companyNumber,
    party.signerName,
    party.signerRole,
    party.signerEmail,
    party.entityId,
    now()
  );
  return serializeParty(db.prepare("SELECT * FROM directory_parties WHERE id = ?").get(id));
}

function signoffFields(templateId) {
  return db
    .prepare(
      `SELECT tf.label, tf.field_type, tf.page, r.role_key, r.label AS role_label
       FROM template_fields tf
       JOIN template_roles r ON r.id = tf.role_id
       WHERE tf.template_id = ? AND tf.field_type IN ('signature','date')
       ORDER BY r.signing_order, tf.field_type DESC`
    )
    .all(templateId);
}

function libraryRow(id) {
  const row = db
    .prepare(
      `SELECT l.*, e.display_name AS entity_name, t.name AS template_name
       FROM library_templates l
       JOIN entities e ON e.id = l.entity_id
       JOIN templates t ON t.id = l.template_id
       WHERE l.id = ?`
    )
    .get(id);
  if (!row) return null;
  const broker = serializeParty(db.prepare("SELECT * FROM directory_parties WHERE id = ?").get(row.broker_party_id));
  const contractor = serializeParty(
    db.prepare("SELECT * FROM directory_parties WHERE id = ?").get(row.contractor_party_id)
  );
  const pack = resolveBrandPack(row.entity_id, {});
  return {
    id: row.id,
    name: row.name,
    entity_id: row.entity_id,
    entity_name: row.entity_name,
    template_id: row.template_id,
    template_name: row.template_name,
    broker,
    contractor,
    cover: {
      front: pack.front?.name || null,
      back: pack.back?.name || null,
      logo: pack.logo?.name || null,
    },
    fields: signoffFields(row.template_id),
    due_diligence: "The due diligence pack is built in the app. The broker signs it before the contract is issued.",
    is_sample: Boolean(row.is_sample),
    sample_note: row.is_sample
      ? "Sample. Bailey, Northwind, Casey and Nina North are examples used to fill fields for testing."
      : null,
    created_at: row.created_at,
  };
}

export function listLibrary() {
  const ids = db.prepare("SELECT id FROM library_templates ORDER BY created_at DESC").all();
  return ids.map((row) => libraryRow(row.id));
}

function asIncoming(party, roleKey) {
  return {
    roleKey,
    company_name: party.company_name,
    signer_name: party.signer_name,
    signer_email: party.signer_email,
    signer_role: party.signer_role,
    company_number: party.company_number || "",
    directory_party_id: party.id || null,
    is_sample: Boolean(party.is_sample),
  };
}

export function contractFromLibrary(input) {
  const saved = libraryRow(input.libraryId);
  if (!saved) throw new Error("Choose a library template");
  const client = saveDirectoryParty(input.client || {}, "client");
  const parties = [
    asIncoming(saved.contractor, "supplier"),
    asIncoming(saved.broker, "agency"),
    asIncoming(client, "company"),
  ];
  let shape = "three";
  if (input.supplier) {
    const supplier = saveDirectoryParty(input.supplier, "supplier");
    parties.splice(1, 0, asIncoming(supplier, "spv"));
    shape = "four";
  }
  return { entityId: saved.entity_id, templateId: saved.template_id, parties, shape };
}

export function saveLibraryTemplate(input) {
  const name = String(input?.name || "").trim();
  if (!name) throw new Error("Give this library template a name");
  const template = db.prepare("SELECT * FROM templates WHERE id = ? AND is_active = 1").get(input?.templateId);
  if (!template) throw new Error("Choose the contract template");
  const entity = db.prepare("SELECT * FROM entities WHERE id = ? AND is_active = 1").get(input?.entityId);
  if (!entity) throw new Error("Choose the broker company that supplies the cover");
  const broker = saveDirectoryParty({ ...input.broker, entityId: entity.id }, "broker");
  const contractor = saveDirectoryParty(input.contractor, "contractor");
  const coverEntityId = broker.entity_id || entity.id;
  ensureStoredDateFields(template.id);
  const id = newId();
  db.prepare(
    `INSERT INTO library_templates (
      id, name, entity_id, template_id, broker_party_id, contractor_party_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, name, coverEntityId, template.id, broker.id, contractor.id, now());
  return libraryRow(id);
}

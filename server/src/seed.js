import { db, newId, now } from "./db.js";
import { FINAL_EVIDENCE, PARTY_LABELS } from "./parties.js";
import { seedDefaultEmailTemplates } from "./mail.js";
import { readBytes, writeBytes } from "./storage.js";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { migrate } from "./migrate.js";
import { ensureAdminPassword } from "./auth.js";
import { applyMasterPdfFields, ensureFallbackSupplierFields, ensureStoredDateFields } from "./documentFields.js";
import { ensureVerifyToken } from "./domainVerify.js";

async function makePdf({ title, subtitle, lines = [], footer }) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  page.drawText(title, { x: 50, y: 780, size: 20, font: bold });
  if (subtitle) page.drawText(subtitle, { x: 50, y: 752, size: 12, font });
  let y = 720;
  for (const line of lines) {
    page.drawText(line, { x: 50, y, size: 11, font });
    y -= 18;
  }
  if (footer) {
    page.drawText(footer, { x: 50, y: 40, size: 9, font, color: rgb(0.3, 0.3, 0.3) });
  }
  return Buffer.from(await doc.save());
}

async function makeCoverPdf(label, color) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]);
  const { width, height } = page.getSize();
  page.drawRectangle({
    x: 0,
    y: 0,
    width,
    height,
    color: rgb(color[0], color[1], color[2]),
  });
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  page.drawText(label, {
    x: 50,
    y: height / 2,
    size: 28,
    font: bold,
    color: rgb(1, 1, 1),
  });
  return Buffer.from(await doc.save());
}

async function makeLogoPng() {
  const { deflateSync } = await import("node:zlib");
  const w = 96;
  const h = 32;
  const row = Buffer.alloc(1 + w * 3);
  row[0] = 0;
  for (let x = 0; x < w; x++) {
    row[1 + x * 3] = 0;
    row[2 + x * 3] = 116;
    row[3 + x * 3] = 255;
  }
  const raw = Buffer.concat(Array.from({ length: h }, () => Buffer.from(row)));
  const compressed = deflateSync(raw);
  function crc32(buf) {
    let c = ~0;
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i];
      for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
    }
    return ~c;
  }
  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeBuf = Buffer.from(type);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0);
    return Buffer.concat([len, typeBuf, data, crc]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", compressed),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function addRolesAndFields(templateId, withEvidence) {
  const roles = [
    { key: "supplier", label: "Contractor", order: 1, evidence: withEvidence ? 1 : 0 },
    { key: "spv", label: "Supplier (SPV)", order: 2, evidence: withEvidence ? 1 : 0 },
    { key: "agency", label: "Broker", order: 3, evidence: 0 },
    { key: "company", label: "Client", order: 4, evidence: withEvidence ? 1 : 0 },
  ];
  const roleIds = {};
  for (const role of roles) {
    const id = newId();
    roleIds[role.key] = id;
    db.prepare(
      `INSERT INTO template_roles (
        id, template_id, role_key, label, signing_order, evidence_required
      ) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, templateId, role.key, role.label, role.order, role.evidence);
  }

  if (withEvidence) {
    insertEvidenceRequirements(roleIds.company, FINAL_EVIDENCE.company);
    insertEvidenceRequirements(roleIds.supplier, FINAL_EVIDENCE.supplier);
    insertEvidenceRequirements(roleIds.spv, FINAL_EVIDENCE.spv);
  }

  return roleIds;
}

const EVIDENCE_MIMES = JSON.stringify(["application/pdf", "image/jpeg", "image/png"]);

function insertEvidenceRequirements(roleId, items) {
  for (const [key, label] of items) {
    const existing = db
      .prepare(
        "SELECT id FROM evidence_requirements WHERE role_id = ? AND requirement_key = ?"
      )
      .get(roleId, key);
    if (existing) {
      db.prepare(
        "UPDATE evidence_requirements SET label = ?, description = ?, is_required = 1 WHERE id = ?"
      ).run(label, label, existing.id);
      continue;
    }
    db.prepare(
      `INSERT INTO evidence_requirements (
        id, role_id, requirement_key, label, description, accepted_mimes,
        max_size_bytes, verify_method, is_required
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'upload', 1)`
    ).run(newId(), roleId, key, label, label, EVIDENCE_MIMES, 10 * 1024 * 1024);
  }
}

const ROLE_ORDER = { supplier: 1, spv: 2, agency: 3, company: 4 };

export function ensureSigningEvidence() {
  const templateIds = db
    .prepare("SELECT DISTINCT template_id FROM template_roles")
    .all()
    .map((row) => row.template_id);
  for (const templateId of templateIds) {
    const existing = db
      .prepare("SELECT id FROM template_roles WHERE template_id = ? AND role_key = 'spv'")
      .get(templateId);
    if (!existing) {
      db.prepare(
        `INSERT INTO template_roles (
          id, template_id, role_key, label, signing_order, evidence_required
        ) VALUES (?, ?, 'spv', 'Supplier (SPV)', 2, 1)`
      ).run(newId(), templateId);
    }
    ensureFallbackSupplierFields(templateId);
  }

  const roles = db.prepare("SELECT * FROM template_roles").all();
  for (const role of roles) {
    const label = PARTY_LABELS[role.role_key] || role.label;
    const order = ROLE_ORDER[role.role_key] || role.signing_order;
    const items = FINAL_EVIDENCE[role.role_key] || [];
    db.prepare(
      "UPDATE template_roles SET label = ?, signing_order = ?, evidence_required = ? WHERE id = ?"
    ).run(label, order, items.length ? 1 : 0, role.id);
    if (!items.length) continue;
    insertEvidenceRequirements(role.id, items);
    const keep = items.map(([key]) => key);
    const stale = db
      .prepare("SELECT id, requirement_key FROM evidence_requirements WHERE role_id = ?")
      .all(role.id)
      .filter((row) => !keep.includes(row.requirement_key));
    for (const row of stale) {
      db.prepare("UPDATE evidence_requirements SET is_required = 0 WHERE id = ?").run(row.id);
    }
  }
  db.prepare(
    "UPDATE template_fields SET label = 'Client signature' WHERE field_key = 'company_sig'"
  ).run();
  db.prepare(
    "UPDATE template_fields SET label = 'Client date' WHERE field_key = 'company_date' AND label = 'Date'"
  ).run();
  db.prepare(
    "UPDATE template_fields SET label = 'Broker signature' WHERE field_key = 'agency_sig'"
  ).run();
  db.prepare(
    "UPDATE template_fields SET label = 'Contractor signature' WHERE field_key = 'supplier_sig'"
  ).run();
}

async function ensureEntityBrand(entityId, brandSpec) {
  const existing = db
    .prepare("SELECT id FROM entity_assets WHERE entity_id = ? LIMIT 1")
    .get(entityId);
  if (existing) return;

  const entity = db.prepare("SELECT * FROM entities WHERE id = ?").get(entityId);
  const label = brandSpec?.label || entity.display_name;
  const frontColor = brandSpec?.frontColor || [0.05, 0.45, 0.44];
  const backColor = brandSpec?.backColor || [0.06, 0.14, 0.17];

  const front = writeBytes(
    "assets",
    `${entityId}-front.pdf`,
    await makeCoverPdf(`${label} Front Cover`, frontColor)
  );
  const back = writeBytes(
    "assets",
    `${entityId}-back.pdf`,
    await makeCoverPdf(`${label} Back Cover`, backColor)
  );
  const logo = writeBytes("assets", `${entityId}-logo.png`, await makeLogoPng());

  const frontId = newId();
  const backId = newId();
  const logoId = newId();
  const insert = db.prepare(
    `INSERT INTO entity_assets (
      id, entity_id, kind, name, storage_ref, mime, page_size, is_active, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'A4', 1, ?)`
  );
  insert.run(
    frontId,
    entityId,
    "front_cover",
    `${label} Front`,
    front.storageRef,
    "application/pdf",
    now()
  );
  insert.run(
    backId,
    entityId,
    "back_cover",
    `${label} Back`,
    back.storageRef,
    "application/pdf",
    now()
  );
  insert.run(
    logoId,
    entityId,
    "logo",
    `${label} Logo`,
    logo.storageRef,
    "image/png",
    now()
  );

  const brand = JSON.parse(entity.brand_json || "{}");
  brand.logo_asset_id = logoId;
  if (brandSpec?.primary) brand.primary = brandSpec.primary;
  if (brandSpec?.secondary) brand.secondary = brandSpec.secondary;
  db.prepare("UPDATE entities SET brand_json = ? WHERE id = ?").run(
    JSON.stringify(brand),
    entityId
  );
}

async function ensureSharedCatalog() {
  // The shared placeholder contract; each broker's own 3-way and 4-way contracts sit beside it.
  let master = db.prepare("SELECT * FROM templates WHERE is_master = 1 AND entity_id IS NULL LIMIT 1").get();
  if (!master) {
    const byName = db
      .prepare("SELECT * FROM templates WHERE name = ? AND entity_id IS NULL LIMIT 1")
      .get("Master Services Agreement");
    if (byName) {
      db.prepare(
        `UPDATE templates SET is_master = 1, is_active = 1, entity_id = NULL,
          industry = NULL, description = ?, default_front_cover = NULL, default_back_cover = NULL
         WHERE id = ?`
      ).run("Core three-party agreement included on every contract", byName.id);
      master = db.prepare("SELECT * FROM templates WHERE id = ?").get(byName.id);
    }
  }

  if (!master) {
    const pdf = await makePdf({
      title: "Master Services Agreement",
      subtitle: "Always included · three-party execution",
      lines: [
        "This master contract is sent with every contract.",
        "Industry-specific schedules are attached as optional appendices.",
        "",
        "Client / Agency / Contractor execution blocks appear below.",
        "",
        "Client signature",
        "Agency signature",
        "Contractor signature",
      ],
      footer: "Master contract template",
    });
    const uploaded = writeBytes("uploads", "master-services-agreement.pdf", pdf);
    const templateId = newId();
    db.prepare(
      `INSERT INTO templates (
        id, entity_id, name, source_url, default_front_cover, default_back_cover,
        is_active, created_at, industry, description, is_master
      ) VALUES (?, NULL, ?, ?, NULL, NULL, 1, ?, NULL, ?, 1)`
    ).run(
      templateId,
      "Master Services Agreement",
      `local://${uploaded.storageRef}`,
      now(),
      "Core three-party agreement included on every contract"
    );
    addRolesAndFields(templateId, true);
    await applyMasterPdfFields(templateId, pdf, { isNew: true });
    master = db.prepare("SELECT * FROM templates WHERE id = ?").get(templateId);
  } else {
    db.prepare(
      `UPDATE templates SET is_master = 1, is_active = 1, entity_id = NULL,
        industry = NULL, default_front_cover = NULL, default_back_cover = NULL,
        description = COALESCE(description, ?)
       WHERE id = ?`
    ).run("Core three-party agreement included on every contract", master.id);
  }

  // Demote legacy per-industry “contracts”; a broker's own contracts carry a party_shape.
  db.prepare(
    `UPDATE templates SET is_active = 0, is_master = 0
     WHERE id != ? AND party_shape IS NULL AND (industry IS NOT NULL OR is_master = 0)`
  ).run(master.id);
  db.prepare(`UPDATE templates SET is_master = 0 WHERE id != ? AND party_shape IS NULL`).run(master.id);

  const roleCount = db
    .prepare("SELECT COUNT(*) AS c FROM template_roles WHERE template_id = ?")
    .get(master.id).c;
  if (!roleCount) addRolesAndFields(master.id, true);
  const fieldCount = db
    .prepare("SELECT COUNT(*) AS c FROM template_fields WHERE template_id = ?")
    .get(master.id).c;
  if (!fieldCount && String(master.source_url || "").startsWith("local://")) {
    try {
      await applyMasterPdfFields(
        master.id,
        readBytes(master.source_url.replace("local://", "")),
        { isNew: true }
      );
    } catch {
      /* detection optional */
    }
  }

  // Schedules now belong to a broker; the old shared demo appendices are retired.
  db.prepare("UPDATE appendices SET is_active = 0 WHERE entity_id IS NULL").run();
}

const COMPANY_DEFS = [
  {
    slug: "union-payroll",
    legal_name: "UNION WORK SERVICES LIMITED (trading as Union Payroll)",
    company_number: "16734536",
    vat_number: null,
    registered_office:
      "International House, 22-28 Wood Street, Doncaster, United Kingdom, DN1 3LW",
    display_name: "Union Payroll",
    sending_domain: "union-payroll.ltd",
    from_address: "hello@union-payroll.ltd",
    reply_to: "hello@union-payroll.ltd",
    brand: {
      primary: "#0074ff",
      secondary: "#101828",
      frontColor: [0.0, 0.455, 1.0],
      backColor: [0.063, 0.094, 0.157],
    },
  },
];

const RETIRED_DEMO_SLUGS = [
  "acme",
  "northwind",
  "contoso",
  "fabrikam",
  "adventureworks",
];

async function ensureCompanies(userId) {
  for (const def of COMPANY_DEFS) {
    let entity = db.prepare("SELECT * FROM entities WHERE slug = ?").get(def.slug);
    if (!entity) {
      const entityId = newId();
      db.prepare(
        `INSERT INTO entities (
          id, slug, legal_name, company_number, vat_number, registered_office,
          display_name, brand_json, sending_domain, from_address, reply_to,
          email_signature_html, email_signature_text, domain_verified, is_active, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?)`
      ).run(
        entityId,
        def.slug,
        def.legal_name,
        def.company_number,
        def.vat_number,
        def.registered_office,
        def.display_name,
        JSON.stringify({
          primary: def.brand.primary,
          secondary: def.brand.secondary,
          logo_asset_id: null,
          font: "Manrope",
        }),
        def.sending_domain,
        def.from_address,
        def.reply_to || `hello@${def.sending_domain}`,
        `<p>Kind regards,<br/>${def.display_name}</p>`,
        `Kind regards,\n${def.display_name}`,
        now()
      );
      if (userId) {
        db.prepare(
          "INSERT OR IGNORE INTO user_entity_access (user_id, entity_id) VALUES (?, ?)"
        ).run(userId, entityId);
      }
      seedDefaultEmailTemplates(entityId, userId);
      entity = db.prepare("SELECT * FROM entities WHERE id = ?").get(entityId);
    } else {
      db.prepare(
        `UPDATE entities SET
          legal_name = ?,
          company_number = ?,
          vat_number = ?,
          registered_office = ?,
          display_name = ?,
          sending_domain = ?,
          from_address = ?,
          reply_to = ?,
          domain_verified = 1,
          is_active = 1
         WHERE id = ?`
      ).run(
        def.legal_name,
        def.company_number,
        def.vat_number,
        def.registered_office,
        def.display_name,
        def.sending_domain,
        def.from_address,
        def.reply_to || entity.reply_to,
        entity.id
      );
      entity = db.prepare("SELECT * FROM entities WHERE id = ?").get(entity.id);
    }
    if (entity.domain_verified && !entity.domain_verified_at) {
      db.prepare("UPDATE entities SET domain_verified_at = ? WHERE id = ?").run(now(), entity.id);
    }
    ensureVerifyToken(entity.id);
    await ensureEntityBrand(entity.id, {
      label: def.display_name,
      primary: def.brand.primary,
      secondary: def.brand.secondary,
      frontColor: def.brand.frontColor,
      backColor: def.brand.backColor,
    });
  }

  if (RETIRED_DEMO_SLUGS.length) {
    const placeholders = RETIRED_DEMO_SLUGS.map(() => "?").join(",");
    db.prepare(
      `UPDATE entities SET is_active = 0 WHERE slug IN (${placeholders})`
    ).run(...RETIRED_DEMO_SLUGS);
  }
}

function markSampleRecords() {
  const sample = "%Bailey%|%Baily%|%Northwind%|%Contoso Contracting%|%Casey%|%Nina North%";
  for (const name of sample.split("|")) {
    db.prepare(
      "UPDATE directory_parties SET is_sample = 1 WHERE company_name LIKE ? OR signer_name LIKE ?"
    ).run(name, name);
    db.prepare(
      "UPDATE envelope_parties SET is_sample = 1 WHERE company_name LIKE ? OR signer_name LIKE ?"
    ).run(name, name);
  }
  db.prepare("UPDATE library_templates SET is_sample = 1 WHERE name LIKE '%Northwind%' OR name LIKE '%Bailey%' OR name LIKE '%Baily%'").run();
  db.prepare(
    `UPDATE envelopes SET is_sample = 1
     WHERE title LIKE '%Northwind%' OR title LIKE '%Bailey%' OR title LIKE '%Baily%'
        OR id IN (SELECT envelope_id FROM envelope_parties WHERE is_sample = 1)`
  ).run();
}

export async function ensureSeed() {
  migrate();
  let user = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
  if (!user) {
    const userId = newId();
    db.prepare(
      `INSERT INTO users (id, email, name, role, is_active, created_at)
       VALUES (?, ?, ?, 'admin', 1, ?)`
    ).run(userId, "ops@attest.local", "Attest Operator", now());
    user = { id: userId };
  }

  await ensureCompanies(user.id);
  await ensureSharedCatalog();
  ensureSigningEvidence();
  for (const entity of db.prepare("SELECT id FROM entities").all()) {
    seedDefaultEmailTemplates(entity.id, user.id);
  }
  ensureAdminPassword();
  markSampleRecords();
  for (const template of db.prepare("SELECT id FROM templates").all()) {
    ensureStoredDateFields(template.id);
  }

  const count = db.prepare("SELECT COUNT(*) AS c FROM entities WHERE is_active = 1").get().c;
  return { seeded: true, companies: count, userId: user.id };
}

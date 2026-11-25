import { db } from "./db.js";

function tableColumns(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

function ensureColumn(table, column, sqlType) {
  const cols = tableColumns(table);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${sqlType}`);
  }
}

function widenEmailTemplates() {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'email_templates'")
    .get();
  if (!row?.sql || row.sql.includes("'dd_request'")) return;
  const columns = tableColumns("email_templates");
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(`
    CREATE TABLE email_templates_new (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL REFERENCES entities(id),
      template_type TEXT NOT NULL CHECK (template_type IN (
        'invitation','resend','reminder','turn_notification',
        'declined_notice','voided_notice','completion',
        'dd_request','dd_review'
      )),
      subject TEXT NOT NULL,
      body_html TEXT NOT NULL,
      body_text TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      updated_by TEXT REFERENCES users(id),
      updated_at TEXT NOT NULL,
      UNIQUE (entity_id, template_type)
    )
  `);
  db.exec(
    `INSERT INTO email_templates_new (${columns.join(", ")})
     SELECT ${columns.join(", ")} FROM email_templates`
  );
  db.exec("DROP TABLE email_templates");
  db.exec("ALTER TABLE email_templates_new RENAME TO email_templates");
  db.exec("PRAGMA foreign_keys = ON");
}

export function migrate() {
  ensureColumn("templates", "industry", "TEXT");
  ensureColumn("templates", "description", "TEXT");
  ensureColumn("templates", "is_master", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("envelopes", "prepared_on", "TEXT");
  ensureColumn("envelopes", "issued_at", "TEXT");
  ensureColumn("envelopes", "industry", "TEXT");
  ensureColumn("envelopes", "template_id", "TEXT");
  ensureColumn("envelopes", "logo_asset_id", "TEXT");
  ensureColumn("envelopes", "appendix_ids_json", "TEXT");
  ensureColumn("envelopes", "contract_page_offset", "INTEGER DEFAULT 0");
  ensureColumn("envelopes", "party_shape", "TEXT");
  ensureColumn("envelopes", "dd_compiled_at", "TEXT");
  ensureColumn("envelopes", "dd_validated_at", "TEXT");
  ensureColumn("envelopes", "dd_validated_by", "TEXT");
  ensureColumn("envelopes", "dd_signed_name", "TEXT");
  ensureColumn("envelopes", "dd_signed_ip", "TEXT");
  ensureColumn("envelopes", "dd_signature_ref", "TEXT");
  ensureColumn("envelope_parties", "dd_submitted_at", "TEXT");
  ensureColumn("envelope_parties", "signer_role", "TEXT");
  ensureColumn("envelope_parties", "is_sample", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("envelopes", "is_sample", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("directory_parties", "is_sample", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("directory_parties", "company_number", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("envelope_parties", "company_number", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("envelope_parties", "directory_party_id", "TEXT");
  ensureColumn("library_templates", "is_sample", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("users", "password_hash", "TEXT");
  ensureColumn("envelopes", "dd_storage_ref", "TEXT");
  ensureColumn("envelopes", "dd_sha256", "TEXT");
  ensureColumn("entities", "intro_email_text", "TEXT");
  ensureColumn("entities", "domain_verify_token", "TEXT");
  ensureColumn("entities", "domain_verified_at", "TEXT");
  ensureColumn("entities", "domain_verify_code_hash", "TEXT");
  ensureColumn("entities", "domain_verify_code_expires", "TEXT");
  ensureColumn("entities", "smtp_host", "TEXT");
  ensureColumn("entities", "smtp_port", "INTEGER");
  ensureColumn("entities", "smtp_user", "TEXT");
  ensureColumn("entities", "smtp_pass", "TEXT");
  ensureColumn("entities", "smtp_provider", "TEXT");

  db.exec(`
    CREATE TABLE IF NOT EXISTS compliance_company (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL DEFAULT '',
      legal_name TEXT NOT NULL DEFAULT '',
      company_number TEXT NOT NULL DEFAULT '',
      registered_office TEXT NOT NULL DEFAULT '',
      from_address TEXT NOT NULL DEFAULT '',
      intro_email_text TEXT NOT NULL DEFAULT '',
      email_signature_html TEXT NOT NULL DEFAULT '',
      email_signature_text TEXT NOT NULL DEFAULT '',
      smtp_host TEXT,
      smtp_port INTEGER,
      smtp_user TEXT,
      smtp_pass TEXT,
      smtp_provider TEXT,
      updated_at TEXT
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS appendices (
      id TEXT PRIMARY KEY,
      entity_id TEXT REFERENCES entities(id),
      industry TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      storage_ref TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
  `);

  db.exec(`DROP TABLE IF EXISTS entity_documents`);

  migrateFieldValuesFk();
  widenEmailTemplates();
  widenRoleKey("template_roles", `CREATE TABLE template_roles_new (
      id TEXT PRIMARY KEY,
      template_id TEXT NOT NULL REFERENCES templates(id),
      role_key TEXT NOT NULL CHECK (role_key IN ('company','agency','supplier','spv')),
      label TEXT,
      signing_order INTEGER NOT NULL,
      evidence_required INTEGER NOT NULL DEFAULT 0,
      UNIQUE (template_id, role_key)
    )`);
  widenRoleKey("appendix_fields", `CREATE TABLE appendix_fields_new (
      id TEXT PRIMARY KEY,
      appendix_id TEXT NOT NULL REFERENCES appendices(id),
      role_key TEXT NOT NULL CHECK (role_key IN ('company','agency','supplier','spv')),
      field_key TEXT NOT NULL,
      label TEXT NOT NULL,
      field_type TEXT NOT NULL CHECK (field_type IN (
        'text','date','checkbox','signature','initials','attachment'
      )),
      required INTEGER NOT NULL DEFAULT 1,
      page INTEGER NOT NULL DEFAULT 0,
      x REAL NOT NULL,
      y REAL NOT NULL,
      w REAL NOT NULL,
      h REAL NOT NULL
    )`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS company_name_changes (
      id TEXT PRIMARY KEY,
      envelope_id TEXT NOT NULL REFERENCES envelopes(id),
      role_key TEXT NOT NULL,
      previous_name TEXT NOT NULL,
      new_name TEXT NOT NULL,
      sort_index INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS pack_files (
      id TEXT PRIMARY KEY,
      envelope_id TEXT NOT NULL REFERENCES envelopes(id),
      role_key TEXT NOT NULL,
      stage TEXT NOT NULL CHECK (stage IN ('dd','appendix')),
      requirement_key TEXT NOT NULL,
      name_change_id TEXT,
      original_name TEXT,
      mime TEXT,
      size_bytes INTEGER,
      storage_ref TEXT NOT NULL,
      file_hash TEXT NOT NULL,
      uploaded_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dd_flags (
      envelope_id TEXT NOT NULL,
      role_key TEXT NOT NULL,
      flag_key TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (envelope_id, role_key, flag_key)
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS appendix_fields (
      id TEXT PRIMARY KEY,
      appendix_id TEXT NOT NULL REFERENCES appendices(id),
      role_key TEXT NOT NULL CHECK (role_key IN ('company','agency','supplier','spv')),
      field_key TEXT NOT NULL,
      label TEXT NOT NULL,
      field_type TEXT NOT NULL CHECK (field_type IN (
        'text','date','checkbox','signature','initials','attachment'
      )),
      required INTEGER NOT NULL DEFAULT 1,
      page INTEGER NOT NULL DEFAULT 0,
      x REAL NOT NULL,
      y REAL NOT NULL,
      w REAL NOT NULL,
      h REAL NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS directory_parties (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('broker','contractor','client','supplier')),
      company_name TEXT NOT NULL,
      signer_name TEXT NOT NULL,
      signer_role TEXT NOT NULL CHECK (signer_role IN ('director','authorised_signatory')),
      signer_email TEXT NOT NULL,
      entity_id TEXT REFERENCES entities(id),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS library_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      entity_id TEXT NOT NULL REFERENCES entities(id),
      template_id TEXT NOT NULL REFERENCES templates(id),
      broker_party_id TEXT NOT NULL REFERENCES directory_parties(id),
      contractor_party_id TEXT NOT NULL REFERENCES directory_parties(id),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS party_registry (
      party_id TEXT PRIMARY KEY REFERENCES directory_parties(id),
      company_number TEXT NOT NULL,
      legal_name TEXT,
      status TEXT,
      incorporated_on TEXT,
      registered_office TEXT,
      company_type TEXT,
      profile_json TEXT,
      officers_json TEXT,
      psc_json TEXT,
      sanctions_json TEXT,
      fetched_at TEXT,
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS party_files (
      id TEXT PRIMARY KEY,
      party_id TEXT NOT NULL REFERENCES directory_parties(id),
      source TEXT NOT NULL CHECK (source IN ('companies_house','upload')),
      requirement_key TEXT NOT NULL,
      label TEXT NOT NULL,
      original_name TEXT,
      mime TEXT,
      storage_ref TEXT NOT NULL,
      file_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS envelope_doc_checks (
      envelope_id TEXT NOT NULL REFERENCES envelopes(id),
      doc_key TEXT NOT NULL,
      received_on TEXT,
      checked_on TEXT,
      PRIMARY KEY (envelope_id, doc_key)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS envelope_fields (
      id TEXT PRIMARY KEY,
      envelope_id TEXT NOT NULL REFERENCES envelopes(id),
      role_id TEXT NOT NULL REFERENCES template_roles(id),
      source TEXT NOT NULL CHECK (source IN ('master','appendix')),
      appendix_id TEXT,
      field_key TEXT NOT NULL,
      label TEXT NOT NULL,
      field_type TEXT NOT NULL CHECK (field_type IN (
        'text','date','checkbox','signature','initials','attachment'
      )),
      required INTEGER NOT NULL DEFAULT 1,
      page INTEGER NOT NULL DEFAULT 0,
      x REAL NOT NULL,
      y REAL NOT NULL,
      w REAL NOT NULL,
      h REAL NOT NULL
    );
  `);

  db.prepare(
    `UPDATE email_templates
     SET body_html = ?, body_text = ?, updated_at = ?
     WHERE template_type = 'completion'
       AND body_text LIKE '%appended audit sheet%'`
  ).run(
    "<p>{{envelope_title}} is complete.</p><p>The completed PDF binds every requested attachment, then ends with the audit trail: who received the file, when they signed, and their IP address.</p>",
    "{{envelope_title}} is complete. The completed PDF binds every requested attachment, then ends with the audit trail: who received the file, when they signed, and their IP address.",
    new Date().toISOString()
  );
}

function widenRoleKey(table, createSql) {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  if (!row?.sql || row.sql.includes("'spv'")) return;
  const columns = tableColumns(table);
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(createSql);
  db.exec(
    `INSERT INTO ${table}_new (${columns.join(", ")})
     SELECT ${columns.join(", ")} FROM ${table}`
  );
  db.exec(`DROP TABLE ${table}`);
  db.exec(`ALTER TABLE ${table}_new RENAME TO ${table}`);
  db.exec("PRAGMA foreign_keys = ON");
}

function migrateFieldValuesFk() {
  const row = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'field_values'"
    )
    .get();
  if (!row?.sql || !/REFERENCES\s+template_fields/i.test(row.sql)) return;
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(`
    CREATE TABLE field_values_new (
      id TEXT PRIMARY KEY,
      envelope_id TEXT NOT NULL REFERENCES envelopes(id),
      field_id TEXT NOT NULL,
      party_id TEXT NOT NULL REFERENCES envelope_parties(id),
      value TEXT,
      value_hash TEXT,
      captured_at TEXT,
      captured_ip TEXT,
      UNIQUE (envelope_id, field_id)
    );
    INSERT INTO field_values_new
      SELECT id, envelope_id, field_id, party_id, value, value_hash, captured_at, captured_ip
      FROM field_values;
    DROP TABLE field_values;
    ALTER TABLE field_values_new RENAME TO field_values;
  `);
  db.exec("PRAGMA foreign_keys = ON");
}

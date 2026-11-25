import { db, now } from "./db.js";
import { smtpConfig } from "./smtp.js";

const ID = "default";

function sourceFromBroker() {
  return (
    db
      .prepare(
        `SELECT intro_email_text, email_signature_html, email_signature_text
         FROM entities
         WHERE intro_email_text IS NOT NULL AND trim(intro_email_text) != ''
         ORDER BY created_at
         LIMIT 1`
      )
      .get() || {}
  );
}

export function getComplianceCompany() {
  let row = db.prepare("SELECT * FROM compliance_company WHERE id = ?").get(ID);
  if (!row) {
    const source = sourceFromBroker();
    db.prepare(
      `INSERT INTO compliance_company (
        id, display_name, legal_name, company_number, registered_office, from_address,
        intro_email_text, email_signature_html, email_signature_text, updated_at
      ) VALUES (?, '', '', '', '', '', ?, ?, ?, ?)`
    ).run(
      ID,
      source.intro_email_text || "",
      source.email_signature_html || "",
      source.email_signature_text || "",
      now()
    );
    row = db.prepare("SELECT * FROM compliance_company WHERE id = ?").get(ID);
  }
  return row;
}

export function publicCompliance(row = getComplianceCompany()) {
  return {
    display_name: row.display_name || "",
    legal_name: row.legal_name || "",
    company_number: row.company_number || "",
    registered_office: row.registered_office || "",
    from_address: row.from_address || "",
    intro_email_text: row.intro_email_text || "",
    email_signature_html: row.email_signature_html || "",
    email_signature_text: row.email_signature_text || "",
    smtp_host: row.smtp_host || "",
    smtp_port: row.smtp_port || 587,
    smtp_user: row.smtp_user || "",
    smtp_provider: row.smtp_provider || "gmail",
    smtp_configured: Boolean(smtpConfig(row)),
    updated_at: row.updated_at || null,
  };
}

function signatureHtml(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return "";
  return trimmed
    .split(/\n{2,}/)
    .map(
      (block) =>
        `<p>${block
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/\n/g, "<br/>")}</p>`
    )
    .join("");
}

export function saveComplianceCompany(input = {}) {
  const current = getComplianceCompany();
  const pass = String(input.smtp_pass || "").trim() ? String(input.smtp_pass).trim() : current.smtp_pass;
  const signatureText =
    input.email_signature_text != null
      ? String(input.email_signature_text)
      : current.email_signature_text;
  db.prepare(
    `UPDATE compliance_company SET
      display_name = ?, legal_name = ?, company_number = ?, registered_office = ?,
      from_address = ?, intro_email_text = ?, email_signature_html = ?, email_signature_text = ?,
      smtp_host = ?, smtp_port = ?, smtp_user = ?, smtp_pass = ?, smtp_provider = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    String(input.display_name ?? current.display_name ?? "").trim(),
    String(input.legal_name ?? current.legal_name ?? "").trim(),
    String(input.company_number ?? current.company_number ?? "").trim(),
    String(input.registered_office ?? current.registered_office ?? "").trim(),
    String(input.from_address ?? current.from_address ?? "").trim(),
    input.intro_email_text != null ? String(input.intro_email_text) : current.intro_email_text,
    input.email_signature_html != null && String(input.email_signature_html).trim()
      ? String(input.email_signature_html)
      : signatureHtml(signatureText),
    signatureText,
    String(input.smtp_host ?? current.smtp_host ?? "").trim(),
    Number(input.smtp_port || current.smtp_port || 587),
    String(input.smtp_user ?? current.smtp_user ?? "").trim(),
    pass || null,
    String(input.smtp_provider ?? current.smtp_provider ?? "gmail").trim(),
    now(),
    ID
  );
  return publicCompliance(getComplianceCompany());
}

import { db, newId, now, sha256, parseJson } from "./db.js";
import { appendEvent } from "./events.js";
import { getComplianceCompany } from "./compliance.js";
import { introForBroker } from "./introEmail.js";
import { deliverMail, smtpConfig } from "./smtp.js";

const REQUIRED_LINK_TYPES = new Set([
  "invitation",
  "resend",
  "turn_notification",
  "dd_request",
  "dd_review",
]);

const MERGE_VARS = [
  "signer_name",
  "signer_company",
  "entity_display_name",
  "envelope_title",
  "signing_link",
  "expiry_date",
  "role_label",
  "declined_by",
  "decline_reason",
];

export function renderTemplate(text, vars) {
  return String(text).replace(/\{\{(\w+)\}\}/g, (_m, key) => {
    if (!(key in vars)) {
      throw new Error(`Unknown merge variable {{${key}}}`);
    }
    return vars[key] ?? "";
  });
}

export function validateTemplateContent(templateType, subject, bodyHtml, bodyText) {
  const combined = `${subject}\n${bodyHtml}\n${bodyText}`;
  const found = [...combined.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
  for (const key of found) {
    if (!MERGE_VARS.includes(key)) {
      throw new Error(`Unknown merge variable {{${key}}}`);
    }
  }
  if (REQUIRED_LINK_TYPES.has(templateType) && !found.includes("signing_link")) {
    throw new Error(`{{signing_link}} is mandatory for ${templateType}`);
  }
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function introToHtml(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return "";
  return trimmed
    .split(/\n{2,}/)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, "<br/>")}</p>`)
    .join("");
}

export function sendTemplatedEmail({
  entityId,
  templateType,
  to,
  vars,
  envelopeId = null,
  partyId = null,
  actor = "system",
}) {
  const entity = db.prepare("SELECT * FROM entities WHERE id = ?").get(entityId);
  if (!entity) throw new Error("Entity not found");
  const tpl = db
    .prepare(
      `SELECT * FROM email_templates
       WHERE entity_id = ? AND template_type = ? AND is_active = 1`
    )
    .get(entityId, templateType);
  if (!tpl) throw new Error(`Missing email template: ${templateType}`);

  const compliance = getComplianceCompany();
  const introText = introForBroker(compliance.intro_email_text, entity.display_name);
  const introHtml = introToHtml(introText);
  const subject = renderTemplate(tpl.subject, vars);
  const signatureHtml = String(compliance.email_signature_html || "").trim();
  const signatureText = String(compliance.email_signature_text || "").trim();
  const bodyHtml = [introHtml, renderTemplate(tpl.body_html, vars), signatureHtml]
    .filter(Boolean)
    .join("\n");
  const bodyText = [introText, renderTemplate(tpl.body_text, vars), signatureText]
    .filter(Boolean)
    .join("\n\n");
  const contentHash = sha256(`${subject}\n${bodyHtml}\n${bodyText}`);

  const id = newId();
  db.prepare(
    `INSERT INTO outbound_emails (
      id, envelope_id, party_id, template_type, to_address,
      subject, body_html, body_text, content_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    envelopeId,
    partyId,
    templateType,
    to,
    subject,
    bodyHtml,
    bodyText,
    contentHash,
    now()
  );

  // Local outbox always. Delivery uses the compliance company mailbox, not the broker.
  const smtp = smtpConfig(compliance);
  if (smtp) {
    deliverMail({
      entity: compliance,
      to,
      subject,
      text: bodyText,
      html: bodyHtml,
      allowOutlook: false,
    })
      .then((delivery) => {
        console.log(`[mail:${templateType}] to=${to} via=${delivery.via} subject=${subject}`);
      })
      .catch((err) => {
        console.error(`[mail:${templateType}] delivery failed to=${to}: ${err.message}`);
      });
  } else {
    console.log(`[mail:${templateType}] to=${to} subject=${subject} (outbox only)`);
  }

  appendEvent({
    envelopeId,
    partyId,
    actor,
    eventType:
      templateType === "invitation"
        ? "invitation_sent"
        : templateType === "resend"
          ? "invitation_resent"
          : templateType === "reminder"
            ? "reminder_sent"
            : `${templateType}_sent`,
    metadata: {
      template_id: tpl.id,
      template_type: templateType,
      content_hash: contentHash,
      to,
      local_only: true,
    },
  });

  return { id, contentHash, subject };
}

export function seedDefaultEmailTemplates(entityId, userId = null) {
  const defaults = [
    {
      type: "dd_request",
      subject: "{{entity_display_name}}: documents for {{envelope_title}}",
      html: "<p>Hi {{signer_name}},</p><p>Please provide the due diligence documents for <strong>{{envelope_title}}</strong>. The page lists each document requested from you.</p><p><a href=\"{{signing_link}}\">Open your document page</a></p>",
      text: "Hi {{signer_name}}, please provide the due diligence documents for {{envelope_title}}. Each requested document is on this page: {{signing_link}}",
    },
    {
      type: "dd_review",
      subject: "{{entity_display_name}}: sign the due diligence pack for {{envelope_title}}",
      html: "<p>Hi {{signer_name}},</p><p>The due diligence documents for <strong>{{envelope_title}}</strong> have been collected. Review the pack and sign to confirm you have checked it and are satisfied with it.</p><p><a href=\"{{signing_link}}\">Review and sign the pack</a></p>",
      text: "Hi {{signer_name}}, the due diligence documents for {{envelope_title}} have been collected. Review the pack and sign it: {{signing_link}}",
    },
    {
      type: "invitation",
      subject: "{{entity_display_name}}: please sign {{envelope_title}}",
      html: "<p>Hi {{signer_name}},</p><p>Please sign <strong>{{envelope_title}}</strong>.</p><p><a href=\"{{signing_link}}\">Open signing link</a></p>",
      text: "Hi {{signer_name}}, please sign {{envelope_title}}: {{signing_link}}",
    },
    {
      type: "resend",
      subject: "Reminder: sign {{envelope_title}}",
      html: "<p>Hi {{signer_name}},</p><p>Your signing link was reissued.</p><p><a href=\"{{signing_link}}\">Continue</a></p>",
      text: "Hi {{signer_name}}, continue signing: {{signing_link}}",
    },
    {
      type: "reminder",
      subject: "Still waiting on {{envelope_title}}",
      html: "<p>Hi {{signer_name}},</p><p>This is a reminder to complete {{envelope_title}}.</p><p><a href=\"{{signing_link}}\">Sign now</a></p>",
      text: "Reminder for {{envelope_title}}: {{signing_link}}",
    },
    {
      type: "turn_notification",
      subject: "Your turn to sign {{envelope_title}}",
      html: "<p>Hi {{signer_name}},</p><p>It is now your turn ({{role_label}}).</p><p><a href=\"{{signing_link}}\">Open document</a></p>",
      text: "Your turn ({{role_label}}): {{signing_link}}",
    },
    {
      type: "declined_notice",
      subject: "{{envelope_title}} was declined",
      html: "<p>{{declined_by}} declined {{envelope_title}}.</p><p>Reason: {{decline_reason}}</p>",
      text: "{{declined_by}} declined {{envelope_title}}: {{decline_reason}}",
    },
    {
      type: "voided_notice",
      subject: "{{envelope_title}} was voided",
      html: "<p>{{envelope_title}} from {{entity_display_name}} was voided.</p>",
      text: "{{envelope_title}} was voided.",
    },
    {
      type: "completion",
      subject: "Completed: {{envelope_title}}",
      html: "<p>{{envelope_title}} is complete.</p><p>The completed PDF binds every requested attachment, then ends with the audit trail: who received the file, when they signed, and their IP address.</p>",
      text: "{{envelope_title}} is complete. The completed PDF binds every requested attachment, then ends with the audit trail: who received the file, when they signed, and their IP address.",
    },
  ];

  const insert = db.prepare(
    `INSERT OR IGNORE INTO email_templates (
      id, entity_id, template_type, subject, body_html, body_text,
      is_active, updated_by, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
  );
  for (const d of defaults) {
    validateTemplateContent(d.type, d.subject, d.html, d.text);
    insert.run(newId(), entityId, d.type, d.subject, d.html, d.text, userId, now());
  }
}

export function listOutboundEmails(envelopeId) {
  return db
    .prepare(
      "SELECT * FROM outbound_emails WHERE envelope_id = ? ORDER BY created_at DESC"
    )
    .all(envelopeId);
}

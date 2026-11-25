import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { db } from "./db.js";
import { listEvents, verifyEventChain } from "./events.js";
import { FINAL_EVIDENCE } from "./parties.js";

const EVENT_LABELS = {
  envelope_created: "Contract created",
  envelope_baked: "Contract assembled",
  invitation_sent: "Invitation sent",
  invitation_resent: "Invitation reissued",
  reminder_sent: "Reminder sent",
  document_viewed: "Opened the contract",
  field_completed: "Completed a field",
  evidence_uploaded: "Attached a supporting document",
  dd_file_uploaded: "Added a due diligence document",
  dd_compiled: "Compiled the due diligence pack",
  dd_requested: "Due diligence documents requested",
  dd_request_sent: "Due diligence request emailed",
  dd_review_sent: "Broker asked to sign the due diligence pack",
  dd_submitted: "Submitted due diligence documents",
  dd_signed: "Broker signed the due diligence pack",
  dd_validated: "Broker signed the due diligence pack",
  consent_given: "Gave electronic-signature consent",
  signed: "Signed",
  declined: "Declined",
  voided: "Voided",
  completed: "All parties complete",
  copies_distributed: "Completed copies recorded",
  turn_notification_sent: "Next-party notice sent",
};

export function eventLabel(type) {
  return EVENT_LABELS[type] || String(type || "").replace(/_/g, " ");
}

function wrap(text, width = 92) {
  const words = String(text || "").split(/\s+/);
  const lines = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > width) {
      if (current) lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

function fmt(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

export async function buildAuditCertificate({
  envelope,
  entity,
  completedHash,
  chain,
  attachmentCount = 0,
}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let page = doc.addPage([595.28, 841.89]);
  let y = 800;

  function ensureSpace(needed = 18) {
    if (y < 48 + needed) {
      page = doc.addPage([595.28, 841.89]);
      y = 800;
    }
  }

  function line(text, { size = 10, weight = font, color = rgb(0.12, 0.14, 0.18), indent = 0 } = {}) {
    for (const part of wrap(text, indent ? 88 : 94)) {
      ensureSpace(size + 6);
      page.drawText(part, { x: 48 + indent, y, size, font: weight, color });
      y -= size + 5;
    }
  }

  line("Audit trail", { size: 18, weight: bold, color: rgb(0, 0.45, 1) });
  y -= 6;
  line(
    "This is the last part of the completed contract. Every requested attachment is bound in front of this page. It records who received the file, when they signed, and the IP address they signed from."
  );
  y -= 8;
  line(entity.legal_name, { weight: bold, size: 11 });
  line(`Contract: ${envelope.title || envelope.id}`);
  line(`Contract ID: ${envelope.id}`);
  line(`Completed: ${fmt(envelope.completed_at || new Date().toISOString())}`);
  line(`Baked document hash (SHA-256): ${envelope.baked_hash || "—"}`);
  if (envelope.party_shape) {
    line(
      `Due diligence pack: ${envelope.dd_validated_at ? `signed ${fmt(envelope.dd_validated_at)} by ${envelope.dd_signed_name || "the broker"}${envelope.dd_signed_ip ? ` · IP ${envelope.dd_signed_ip}` : ""}` : "not signed by the broker"} · SHA-256 ${envelope.dd_sha256 || "—"}`
    );
  }
  line(`Signed contract hash (SHA-256, before attachments and this audit trail): ${completedHash || "—"}`);
  line(`Requested attachments bound before this audit trail: ${attachmentCount}`);
  line(
    `Audit chain: ${chain?.ok ? "verified" : "BROKEN"} · ${chain?.checked || 0} events`
  );
  y -= 10;

  const parties = db
    .prepare(
      `SELECT p.*, r.role_key, r.label AS role_label
       FROM envelope_parties p
       JOIN template_roles r ON r.id = p.role_id
       WHERE p.envelope_id = ?
       ORDER BY p.order_index ASC`
    )
    .all(envelope.id);

  for (const party of parties) {
    ensureSpace(90);
    const signerRole =
      party.signer_role === "authorised_signatory" ? "Authorised signatory" : party.signer_role === "director" ? "Director" : "";
    line(`${party.role_label}: ${party.signer_name}${signerRole ? ` · ${signerRole}` : ""}`, { size: 12, weight: bold });
    line(`${party.company_name} · ${party.signer_email}`);
    const received = db
      .prepare(
        `SELECT created_at, ip FROM events
         WHERE envelope_id = ? AND party_id = ? AND event_type = 'invitation_sent'
         ORDER BY id ASC LIMIT 1`
      )
      .get(envelope.id, party.id);
    const opened = db
      .prepare(
        `SELECT created_at, ip, user_agent FROM events
         WHERE envelope_id = ? AND party_id = ? AND event_type = 'document_viewed'
         ORDER BY id ASC LIMIT 1`
      )
      .get(envelope.id, party.id);
    const signed = db
      .prepare("SELECT * FROM signatures WHERE envelope_id = ? AND party_id = ?")
      .get(envelope.id, party.id);
    line(`Received the file: ${fmt(received?.created_at || opened?.created_at)}`);
    line(`Signed: ${fmt(signed?.signed_at)}`);
    line(`IP address: ${signed?.ip || opened?.ip || "—"}`);
    if (opened?.created_at) line(`Opened: ${fmt(opened.created_at)} · IP ${opened.ip || "—"}`);
    if (signed?.user_agent) line(`Device: ${signed.user_agent}`, { indent: 12, size: 9 });
    if (signed?.consent_given_at) {
      line(`Consent recorded: ${fmt(signed.consent_given_at)}`);
    }
    const allowed = new Set((FINAL_EVIDENCE[party.role_key] || []).map(([key]) => key));
    const files = db
      .prepare(
        `SELECT f.original_name, f.file_hash, f.uploaded_at, f.uploaded_ip, r.label, r.requirement_key
         FROM evidence_files f
         JOIN evidence_requirements r ON r.id = f.requirement_id
         WHERE f.envelope_id = ? AND f.party_id = ? AND f.deleted_at IS NULL
         ORDER BY f.uploaded_at ASC`
      )
      .all(envelope.id, party.id)
      .filter((file) => allowed.has(file.requirement_key));
    if (files.length) {
      line("Bound in front of this page:", { weight: bold });
      for (const file of files) {
        line(
          `${file.label}: ${file.original_name} · ${fmt(file.uploaded_at)} · IP ${file.uploaded_ip || "—"}`,
          { indent: 12 }
        );
        line(`SHA-256 ${file.file_hash}`, { indent: 12, size: 8 });
      }
    } else {
      line("Documents attached: none");
    }
    y -= 8;
  }

  line("Full audit trail", { size: 12, weight: bold });
  const events = listEvents(envelope.id);
  for (const event of events) {
    const who = event.party_id
      ? parties.find((p) => p.id === event.party_id)
      : null;
    const actor = who
      ? `${who.role_label} (${who.signer_name})`
      : event.actor || "system";
    line(
      `${fmt(event.created_at)} · ${eventLabel(event.event_type)} · ${actor} · IP ${event.ip || "—"}`
    );
    if (event.metadata?.original_name || event.metadata?.requirement_key) {
      line(
        `Attachment: ${event.metadata.original_name || event.metadata.requirement_key}`,
        { indent: 12, size: 9 }
      );
    }
  }

  y -= 10;
  line(
    "Hashes are SHA-256 of the PDF bytes at bake and after signatures were applied. Event rows are hash-chained; a later change to any recorded step breaks the chain.",
    { size: 8, color: rgb(0.3, 0.32, 0.35) }
  );

  return doc;
}

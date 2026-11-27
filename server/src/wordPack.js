import { PDFDocument, StandardFonts } from "pdf-lib";
import { db, newId, now } from "./db.js";
import { appendEvent } from "./events.js";
import { embedLogoImage, resolveBrandPack } from "./bake.js";
import { appendBoundAttachments } from "./boundDocuments.js";
import { getComplianceCompany } from "./compliance.js";
import { contractReference, coverDetails, coverTokens, ukDate } from "./coverStamp.js";
import { addMonths, localDay } from "./ddChecks.js";
import { docxBlocks } from "./docxContent.js";
import { docxOutline, docxTokens, fillDocx, isWordFile } from "./docxTemplate.js";
import { renderBlocks } from "./docLayout.js";
import { contractPartyDetails } from "./documentFields.js";
import {
  PackWriter,
  addBrandedBackCover,
  addBrandedCover,
  addPlainCover,
  brokerLegalName,
  drawFrame,
  packText,
  packTheme,
  wordmarkParts,
} from "./packLayout.js";
import { insuranceFor } from "./partyRecords.js";
import { readPartySignature, recordForEnvelopeParty, sameSigner } from "./savedSignatures.js";
import { SIGNATURE_MAX_HEIGHT } from "./signatureInput.js";
import { readBytes, writeBase64Png, writeBytes } from "./storage.js";
import { paymentModelsLabel } from "./wordContract.js";

/*
 * A broker's own due diligence pack (Parts A–K, a Word template) on 3-way lower and higher contracts.
 * Staff fill it in the app from a form built from the template; nobody is emailed. The contractor's
 * saved signature signs Part J when the pack is compiled, and the broker signs Part K.
 */

export const PACK_TYPES = ["three_lower", "three_higher"];
const LOCKED = ["in_progress", "completed", "declined", "voided", "expired"];
const ACCEPTED = ["application/pdf", "image/jpeg", "image/png"];
const OUTCOMES_THAT_ISSUE = ["Approved", "Approved with conditions"];

/** Filled by the app, never typed: the parties, the contract's terms, references and dates, the broker's details. */
const FIXED = new Set([
  "contractor.legal_name",
  "pack.client_names",
  "pack.payment_models",
  "pack.cis_applies",
  "pack.reference",
  "pack.generated_date",
]);
const isFixed = (path) => FIXED.has(path) || /^(doc|broker|engagement|sig)\./.test(path);
const isDateField = (path) => /(date|expiry|appointed|accounts_last_filed|accounts_next_due)$/.test(path);
const isLongField = (path) =>
  /(details|note|notes|conditions|address|office|other_accounts|directors|employing_entities|payers|trading_names|result|nature_of_control)$/.test(path);
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

const FILE_LABELS = {
  vat_certificate: "VAT registration certificate",
  paye_scheme_evidence: "HMRC PAYE scheme evidence",
  bank_evidence: "Bank statement",
  insurance_certificates: "Insurance certificate",
  hmrc_bta_screenshots: "HMRC Business Tax Account screenshots",
  latest_fps: "Latest FPS submission",
  hmrc_supporting: "HMRC supporting evidence",
  sample_payslip: "Sample payslip",
  cis_registration: "HMRC CIS registration",
  cis300_latest: "Latest CIS300 acknowledgement",
  cis_statement_sample: "CIS payment and deduction statement",
  cis_status_process: "Employment-status assessment process",
  chain_agreement: "Chain Agreement",
  chain_insurance: "Chain Entity insurance",
  "checks.companies_house.screenshot": "Companies House status page",
  "checks.vat.screenshot": "HMRC VAT checker result",
  "checks.sanctions.report": "Sanctions and PEP screening",
  "checks.insolvency.screenshot": "Insolvency register search",
  "checks.ccj.screenshot": "County court judgments search",
  "checks.chain.screenshots": "Chain Entity checks",
  "checks.chain.companies_house_screenshot": "Chain Entity Companies House status page",
};

/** Pack uploads the contractor's record already holds. */
const RECORD_FILES = {
  vat_certificate: ["vat"],
  bank_evidence: ["bank"],
  insurance_certificates: ["el_certificate", "pl_certificate", "pi_certificate"],
  sample_payslip: ["payslip"],
};

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** "24 October 2022" → "2022-10-24". */
function isoFromWords(text) {
  const match = String(text || "").match(/(\d{1,2}) ([A-Za-z]+) (\d{4})/);
  const month = match ? MONTHS.indexOf(match[2].toLowerCase()) : -1;
  return month < 0 ? "" : `${match[3]}-${String(month + 1).padStart(2, "0")}-${match[1].padStart(2, "0")}`;
}

/** "MILNES, James Alexander John" → "James Alexander John Milnes". */
function personName(name) {
  const [surname, rest] = String(name || "").split(/,\s*/);
  if (!rest) return String(name || "").trim();
  const title = surname.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (whole, sep, letter) => sep + letter.toUpperCase());
  return `${rest.trim()} ${title}`;
}

const parse = (json, fallback) => {
  try {
    return json ? JSON.parse(json) ?? fallback : fallback;
  } catch {
    return fallback;
  }
};

const positionLabel = (role) => (role === "authorised_signatory" ? "Authorised signatory" : "Director");

function brokerRow(entityId) {
  return db
    .prepare("SELECT id, display_name, legal_name, company_number, registered_office, vat_number, brand_json FROM entities WHERE id = ?")
    .get(entityId);
}

// ——— Pack templates ———

export function packTemplateFor(entityId, contractType) {
  return (
    db
      .prepare(
        "SELECT * FROM pack_templates WHERE entity_id = ? AND contract_type = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 1"
      )
      .get(entityId, contractType) || null
  );
}

export function packTemplateView(row) {
  if (!row) return null;
  return { id: row.id, contract_type: row.contract_type, file_name: row.file_name, created_at: row.created_at };
}

export async function savePackTemplate(entityId, contractType, file) {
  if (!PACK_TYPES.includes(contractType)) {
    throw new Error("A broker's own due diligence pack is used on 3-way lower and 3-way higher contracts");
  }
  const entity = brokerRow(entityId);
  if (!entity) throw new Error("Broker not found");
  if (!file?.buffer || !isWordFile(file.buffer)) throw new Error("Upload the due diligence pack as a Word file (.docx)");
  const tokens = docxTokens(file.buffer);
  const needed = ["sig.contractor_director.signature", "sig.broker_reviewer.signature"].filter((path) => !tokens.signatures.has(path));
  if (needed.length) {
    throw new Error(`This Word file has no place for ${needed.map((path) => `{{${path}}}`).join(" or ")}, so it can't be signed`);
  }
  const outline = docxOutline(file.buffer, { names: [entity.display_name, entity.legal_name] });
  if (!outline.sections.length) throw new Error("No Parts with fields were found in this Word file");
  const preview = await PDFDocument.create();
  const fonts = await packFonts(preview, entity);
  renderBlocks(new PackWriter(preview, fonts), packBlocks(fillDocx(file.buffer, { keepTokens: true })).blocks, { showFields: true });
  const pdf = Buffer.from(await preview.save());
  const stamp = `pack-${contractType}-${Date.now()}`;
  const docx = writeBytes("uploads", `${stamp}.docx`, file.buffer);
  const previewFile = writeBytes("uploads", `${stamp}.pdf`, pdf);
  const id = newId();
  db.prepare("UPDATE pack_templates SET is_active = 0 WHERE entity_id = ? AND contract_type = ?").run(entityId, contractType);
  db.prepare(
    `INSERT INTO pack_templates (id, entity_id, contract_type, file_name, docx_ref, preview_ref, outline_json, is_active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`
  ).run(id, entityId, contractType, file.originalname || "Due diligence pack.docx", docx.storageRef, previewFile.storageRef, JSON.stringify(outline), now());
  return packTemplateView(packTemplateFor(entityId, contractType));
}

export function deletePackTemplate(entityId, contractType) {
  db.prepare("UPDATE pack_templates SET is_active = 0 WHERE entity_id = ? AND contract_type = ?").run(entityId, contractType);
}

/**
 * The broker's pack for this contract: the broker's current one until the pack is compiled, then the
 * one it was compiled from. None on a 4-way, which keeps the app's own pack.
 */
export function packTemplateForEnvelope(envelope) {
  if (!envelope || envelope.party_shape !== "three") return null;
  const settled = LOCKED.includes(envelope.status) || envelope.dd_compiled_at;
  if (settled) {
    return envelope.pack_template_id ? db.prepare("SELECT * FROM pack_templates WHERE id = ?").get(envelope.pack_template_id) : null;
  }
  const current = packTemplateFor(envelope.entity_id, envelope.contract_type);
  if ((current?.id || null) !== (envelope.pack_template_id || null)) {
    db.prepare("UPDATE envelopes SET pack_template_id = ? WHERE id = ?").run(current?.id || null, envelope.id);
    envelope.pack_template_id = current?.id || null;
  }
  return current;
}

// ——— Values ———

function readPack(envelope) {
  const saved = parse(envelope.pack_json, {});
  return { values: saved.values || {}, counts: saved.counts || {}, signedOn: saved.signedOn || "" };
}

function writePack(envelopeId, pack) {
  db.prepare("UPDATE envelopes SET pack_json = ? WHERE id = ?").run(JSON.stringify(pack), envelopeId);
}

function packParties(envelope) {
  const parties = contractPartyDetails(envelope.id);
  const byRole = Object.fromEntries(parties.map((party) => [party.role_key, party]));
  const contractor = byRole.supplier || null;
  const record = contractor ? recordForEnvelopeParty(envelope, contractor) : null;
  const registry = record ? db.prepare("SELECT * FROM party_registry WHERE party_id = ?").get(record.id) : null;
  return { byRole, contractor, record, registry };
}

function currentOfficers(registry) {
  return parse(registry?.officers_json, []).filter((officer) => !officer.resignedOn && !/resigned/i.test(officer.status || ""));
}

/** What the records and Companies House already say, used wherever staff haven't typed anything. */
function packDefaults(envelope, { contractor, record, registry }) {
  const profile = parse(registry?.profile_json, {});
  const directors = currentOfficers(registry).filter((officer) => /director/i.test(officer.role || ""));
  const pscs = parse(registry?.psc_json, []).filter((person) => !person.ceasedOn && !/ceased/i.test(person.status || ""));
  const sanctions = parse(registry?.sanctions_json, null);
  const values = {
    "pack.prepared_by": getComplianceCompany().display_name || "",
    "pack.review_date": addMonths(localDay(), 12),
    "contractor.company_number": contractor?.company_number || "",
    "contractor.registered_office": contractor?.registered_office || "",
    "contractor.incorporation_date": isoFromWords(registry?.incorporated_on),
    "contractor.companies_house.status": registry?.status || "",
    "contractor.companies_house.confirmation_statement_date": isoFromWords(
      String(profile.confirmationStatement || "").match(/Last statement dated (.+?\d{4})/)?.[1]
    ),
    "contractor.companies_house.accounts_last_filed": isoFromWords(String(profile.accounts || "").match(/Last accounts made up to (.+?\d{4})/)?.[1]),
    "contractor.companies_house.accounts_next_due": isoFromWords(String(profile.accounts || "").match(/due by (.+?\d{4})/)?.[1]),
    "contractor.ern": record?.paye_reference || "",
    "contractor.paye_refs": record?.paye_reference || "",
    "contractor.notices_email": contractor?.signer_email || "",
  };
  if (contractor && contractor.signer_role !== "authorised_signatory") {
    values["contacts.compliance_director.name"] = contractor.signer_name || "";
    values["contacts.compliance_director.email"] = contractor.signer_email || "";
  }
  directors.forEach((officer, index) => {
    values[`contractor.directors[${index}].name`] = personName(officer.name);
    values[`contractor.directors[${index}].role`] = officer.role || "Director";
    values[`contractor.directors[${index}].appointed`] = isoFromWords(officer.appointedOn);
    values[`contractor.directors[${index}].residence`] = officer.country || "";
  });
  pscs.forEach((person, index) => {
    values[`contractor.pscs[${index}].name`] = personName(person.name);
    values[`contractor.pscs[${index}].nature_of_control`] = person.natureOfControl || "";
    values[`contractor.pscs[${index}].notified_date`] = isoFromWords(person.notifiedOn);
  });
  for (const policy of record ? insuranceFor(record) : []) {
    values[`insurance.${policy.key}.insurer`] = policy.insurer;
    values[`insurance.${policy.key}.policy`] = policy.policyNumber;
    values[`insurance.${policy.key}.limit`] = policy.cover != null ? `£${policy.cover.toLocaleString("en-GB")}` : "";
    values[`insurance.${policy.key}.expiry`] = policy.expiresOn;
  }
  if (registry?.status) {
    values["checks.companies_house.result"] =
      `${registry.status}; ${directors.length} ${directors.length === 1 ? "director" : "directors"} and ` +
      `${pscs.length} ${pscs.length === 1 ? "PSC" : "PSCs"} on the register`;
  }
  if (sanctions) {
    values["checks.sanctions.result"] = sanctions.hitCount
      ? `${sanctions.hitCount} possible ${sanctions.hitCount === 1 ? "match" : "matches"} on the UK Sanctions List`
      : "No match on the UK Sanctions List";
  }
  return { values, counts: { "contractor.directors": directors.length, "contractor.pscs": pscs.length } };
}

function fixedValues(envelope, entity, byRole, generatedOn) {
  const reference = contractReference(envelope, "DD");
  const brokerName = brokerLegalName(entity) || entity.display_name;
  return {
    "contractor.legal_name": byRole.supplier?.company_name || "",
    "pack.client_names": byRole.company?.company_name || "",
    "pack.payment_models": paymentModelsLabel(envelope.payment_models),
    "pack.cis_applies": envelope.payment_models === "paye_cis" ? "Applicable" : "Not applicable",
    "pack.reference": reference,
    "pack.generated_date": generatedOn,
    "doc.id": reference,
    "doc.reference": reference,
    "broker.legal_name": brokerName,
    "broker.company_number": entity.company_number || "",
    "broker.registered_office": entity.registered_office || "",
    "broker.vat_number": entity.vat_number || "",
    "broker.notices_contact": brokerName,
  };
}

// ——— The form ———

const blockFields = (block) =>
  block.type === "check" ? [{ kind: "check", path: block.path }] : block.type === "record" ? block.rows.flatMap((row) => row.fields) : block.fields || [];

function annotate(field) {
  if (field.kind !== "field") return field;
  return { ...field, type: isDateField(field.path) ? "date" : isLongField(field.path) ? "long" : "text" };
}

/** The template's outline without the fields the app fills itself, each field marked as a date, long text or text. */
function formSections(outline) {
  return outline.sections
    .map((section) => ({
      ...section,
      blocks: section.blocks
        .map((block) => {
          if (block.type === "row") return { ...block, fields: block.fields.filter((field) => !isFixed(field.path)).map(annotate) };
          if (block.type === "table") return { ...block, group: block.arrays[0], fields: block.fields.map(annotate) };
          if (block.type === "record") {
            return { ...block, group: block.arrays[0], rows: block.rows.map((row) => ({ ...row, fields: row.fields.map(annotate) })) };
          }
          return block;
        })
        .filter((block) => block.type !== "row" || block.fields.length),
    }))
    .filter((section) => section.blocks.some((block) => !["heading", "note"].includes(block.type)));
}

const groupsOf = (outline) =>
  outline.sections.flatMap((section) => section.blocks.filter((block) => block.type === "table" || block.type === "record"));

/** Every field the form takes, by path, with [] for a numbered row. */
function formFields(outline) {
  const out = new Map();
  for (const section of outline.sections) {
    for (const block of section.blocks) {
      for (const field of blockFields(block)) out.set(field.path, { ...field, condition: block.condition || null });
    }
  }
  return out;
}

const rowFree = (key) => key.replace(/\[\d+\]/g, "[]");

/** Upload and screenshot keys in the order they appear, numbered rows written out for each row in use. */
function evidenceKeys(outline, counts, conditions) {
  const keys = [];
  for (const section of outline.sections) {
    for (const block of section.blocks) {
      if (block.condition && !conditions[block.condition]) continue;
      const count = block.group ? counts[block.group] ?? 0 : block.arrays ? counts[block.arrays[0]] ?? 0 : 1;
      for (const field of blockFields(block)) {
        if (field.kind !== "upload" && field.kind !== "image") continue;
        if (!field.path.includes("[]")) keys.push({ key: field.path, kind: field.kind });
        else for (let index = 0; index < count; index += 1) keys.push({ key: field.path.replace("[]", `[${index}]`), kind: field.kind });
      }
    }
  }
  return keys;
}

function fileLabel(key) {
  const base = key.replace(/\[\d+\]/g, "");
  const index = key.match(/\[(\d+)\]/)?.[1];
  const label = FILE_LABELS[base] || base;
  return index == null ? label : `${label}, ${base.includes("chain") ? "Chain Entity" : "item"} ${Number(index) + 1}`;
}

function packFiles(envelopeId) {
  return db.prepare("SELECT * FROM word_pack_files WHERE envelope_id = ? ORDER BY created_at ASC").all(envelopeId);
}

function recordFiles(record, key) {
  const wanted = RECORD_FILES[key];
  if (!record || !wanted) return [];
  const files = db
    .prepare("SELECT * FROM party_files WHERE party_id = ? AND source = 'upload' ORDER BY created_at ASC")
    .all(record.id);
  return wanted
    .map((requirement) => [...files].reverse().find((file) => file.requirement_key === requirement))
    .filter(Boolean);
}

/** The files for one upload: those attached to the pack, else those on the contractor's record. */
function filesForKey(envelopeId, record, key, attached = packFiles(envelopeId)) {
  const own = attached.filter((file) => file.field_key === key);
  if (own.length) return own.map((file) => ({ ...file, source: "pack" }));
  return recordFiles(record, key).map((file) => ({ ...file, source: "record", field_key: key }));
}

function publicFile(file) {
  return {
    id: file.id,
    source: file.source,
    original_name: file.original_name,
    label: file.source === "record" ? file.label : "",
    created_at: file.created_at,
    party_id: file.source === "record" ? file.party_id : null,
  };
}

function isOfficer(registry, name) {
  const words = String(name || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!registry || words.length < 2) return null;
  return currentOfficers(registry).some((officer) => {
    const own = personName(officer.name).toLowerCase().split(/\s+/);
    return own.includes(words[0]) && own.includes(words[words.length - 1]);
  });
}

function certificateGaps(contractor, record, signedOn) {
  const gaps = [];
  if (!contractor) return ["Add the contractor to the contract"];
  if (!record) gaps.push(`Save ${contractor.company_name} as a contractor, with its signatory’s saved signature (Part J)`);
  else if (!record.signature_ref) gaps.push(`Add ${contractor.signer_name}’s saved signature on the contractor’s record (Part J)`);
  else if (!sameSigner(record.signer_name, contractor.signer_name)) {
    gaps.push(`The contractor’s saved signature is for ${record.signer_name}, not ${contractor.signer_name} (Part J)`);
  }
  if (signedOn && signedOn > localDay()) gaps.push("The director’s certificate can’t be dated after today (Part J)");
  return gaps;
}

function approvalGaps(values) {
  const outcome = values["partk.outcome"];
  if (!outcome) return ["Choose the outcome in Part K"];
  if (!OUTCOMES_THAT_ISSUE.includes(outcome)) return ["Part K says Declined, so this contract can’t be sent"];
  return [];
}

function packContext(envelope) {
  const template = packTemplateForEnvelope(envelope);
  if (!template) return null;
  const outline = parse(template.outline_json, { sections: [] });
  const people = packParties(envelope);
  const defaults = packDefaults(envelope, people);
  const pack = readPack(envelope);
  const values = { ...defaults.values, ...pack.values };
  const counts = { ...defaults.counts, ...pack.counts };
  for (const group of groupsOf(outline)) counts[group.arrays[0]] = Math.max(0, Number(counts[group.arrays[0]] ?? 0));
  return { template, outline, people, defaults, pack, values, counts };
}

export function usesWordPack(envelope) {
  return Boolean(packTemplateForEnvelope(envelope));
}

/** The pack as staff see it on the contract: the form, what's been entered, files, and what blocks each step. */
export function wordPackState(envelopeId) {
  const envelope = db.prepare("SELECT * FROM envelopes WHERE id = ?").get(envelopeId);
  const context = packContext(envelope);
  if (!context) return null;
  const { template, outline, people, defaults, pack, values, counts } = context;
  const fields = formFields(outline);
  const attached = packFiles(envelopeId);
  const files = {};
  for (const [path, field] of fields) {
    if (field.kind !== "upload" && field.kind !== "image") continue;
    const rows = path.includes("[]") ? Array.from({ length: Math.max(1, counts[path.split("[]")[0]] ?? 0) }, (_, i) => path.replace("[]", `[${i}]`)) : [path];
    for (const key of rows) files[key] = filesForKey(envelopeId, people.record, key, attached).map(publicFile);
  }
  for (const group of groupsOf(outline)) {
    if (counts[group.arrays[0]] == null) counts[group.arrays[0]] = 0;
  }
  const { contractor, record, registry } = people;
  const signedOn = pack.signedOn || "";
  const certificate = certificateGaps(contractor, record, signedOn);
  const approval = approvalGaps(values);
  const locked = LOCKED.includes(envelope.status) || Boolean(envelope.dd_validated_at);
  return {
    applies: true,
    kind: "word",
    template: { id: template.id, file_name: template.file_name },
    sections: formSections(outline),
    values: Object.fromEntries(Object.entries(values).filter(([key]) => !isFixed(key))),
    fromRecords: Object.keys(defaults.values).filter((key) => !(key in pack.values)),
    fixed: fixedValues(envelope, brokerRow(envelope.entity_id), people.byRole, envelope.dd_compiled_at ? ukDate(envelope.dd_compiled_at) : ""),
    counts,
    files,
    cisInScope: envelope.payment_models === "paye_cis",
    certificate: {
      name: contractor?.signer_name || "",
      position: positionLabel(contractor?.signer_role),
      company: contractor?.company_name || "",
      signedOn,
      recordId: record?.id || null,
      officer: isOfficer(registry, contractor?.signer_name),
    },
    compileBlockers: certificate,
    blockers: approval,
    readyToCompile: certificate.length === 0,
    locked,
    compiledAt: envelope.dd_compiled_at || null,
    validatedAt: envelope.dd_validated_at || null,
    validatedBy: envelope.dd_validated_by || null,
    signedName: envelope.dd_signed_name || null,
    hasFile: Boolean(envelope.dd_storage_ref),
  };
}

function editableEnvelope(envelopeId) {
  const envelope = db.prepare("SELECT * FROM envelopes WHERE id = ?").get(envelopeId);
  if (!envelope) throw new Error("Contract not found");
  if (LOCKED.includes(envelope.status)) throw new Error("The due diligence pack is locked once the contract has been issued");
  if (envelope.dd_validated_at) throw new Error("The broker has signed this pack, so it can no longer be changed");
  const context = packContext(envelope);
  if (!context) throw new Error("This contract does not use the broker's own due diligence pack");
  return { envelope, context };
}

function clearCompiled(envelopeId) {
  db.prepare(
    `UPDATE envelopes
     SET dd_compiled_at = NULL, dd_validated_at = NULL, dd_validated_by = NULL, dd_storage_ref = NULL, dd_sha256 = NULL,
         dd_signed_name = NULL, dd_signed_ip = NULL, dd_signature_ref = NULL, dd_pack_build = NULL
     WHERE id = ?`
  ).run(envelopeId);
}

/** The pack prints the contract's payment models, so changing them means compiling and signing it again. */
export function paymentModelsChanged(envelopeId) {
  const envelope = db.prepare("SELECT status, pack_template_id, dd_compiled_at FROM envelopes WHERE id = ?").get(envelopeId);
  if (envelope?.pack_template_id && envelope.dd_compiled_at && !LOCKED.includes(envelope.status)) clearCompiled(envelopeId);
}

function cleanValue(field, value) {
  if (value === null || value === undefined) return undefined;
  if (field.kind === "check") return Boolean(value);
  if (field.kind === "yn") return value === true || value === "yes" ? "yes" : value === false || value === "no" ? "no" : undefined;
  if (field.kind === "select") {
    if (value === "") return undefined;
    if (!field.options.includes(value)) throw new Error(`Choose one of: ${field.options.join(", ")}`);
    return value;
  }
  const text = String(value).trim().slice(0, 2000);
  if (field.type === "date" && text && !ISO_DAY.test(text)) throw new Error("Enter dates as calendar dates");
  return text;
}

/** Saves typed answers (null puts a field back to what the records say), row counts and the Part J date. */
export function saveWordPack(envelopeId, input = {}) {
  const { envelope, context } = editableEnvelope(envelopeId);
  const fields = formFields(context.outline);
  const pack = readPack(envelope);
  for (const [key, value] of Object.entries(input.values || {})) {
    const field = fields.get(rowFree(key));
    if (!field || isFixed(field.path) || field.kind === "upload" || field.kind === "image") throw new Error(`Unknown pack field: ${key}`);
    const clean = cleanValue(annotate(field), value);
    if (clean === undefined) delete pack.values[key];
    else pack.values[key] = clean;
  }
  const groups = new Set(groupsOf(context.outline).map((group) => group.arrays[0]));
  for (const [group, count] of Object.entries(input.counts || {})) {
    if (!groups.has(group)) throw new Error(`Unknown list in the pack: ${group}`);
    const rows = Number(count);
    if (!Number.isInteger(rows) || rows < 0 || rows > 50) throw new Error("A list in the pack can have up to 50 rows");
    pack.counts[group] = rows;
  }
  if (input.signedOn !== undefined) {
    const day = String(input.signedOn || "");
    if (day && !ISO_DAY.test(day)) throw new Error("Enter the director’s certificate date as a calendar date");
    if (day && day > localDay()) throw new Error("The director’s certificate can’t be dated after today");
    pack.signedOn = day;
  }
  writePack(envelopeId, pack);
  clearCompiled(envelopeId);
  return wordPackState(envelopeId);
}

export function saveWordPackFile(envelopeId, key, file) {
  const { context } = editableEnvelope(envelopeId);
  const field = formFields(context.outline).get(rowFree(String(key || "")));
  if (!field || (field.kind !== "upload" && field.kind !== "image")) throw new Error("Unknown pack upload");
  if (!file?.buffer?.length) throw new Error("File required");
  if (!ACCEPTED.includes(file.mimetype)) throw new Error("Upload a PDF, JPG or PNG");
  const stored = writeBytes("diligence", `${envelopeId}-${Date.now()}-${String(file.originalname || "file").replace(/[^\w.-]+/g, "_")}`, file.buffer);
  db.prepare(
    `INSERT INTO word_pack_files (id, envelope_id, field_key, original_name, mime, storage_ref, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(newId(), envelopeId, key, file.originalname || "file", file.mimetype, stored.storageRef, now());
  clearCompiled(envelopeId);
  return wordPackState(envelopeId);
}

export function removeWordPackFile(envelopeId, fileId) {
  editableEnvelope(envelopeId);
  const result = db.prepare("DELETE FROM word_pack_files WHERE id = ? AND envelope_id = ?").run(fileId, envelopeId);
  if (!result.changes) throw new Error("File not found");
  clearCompiled(envelopeId);
  return wordPackState(envelopeId);
}

export function readWordPackFile(envelopeId, fileId) {
  return db.prepare("SELECT * FROM word_pack_files WHERE id = ? AND envelope_id = ?").get(fileId, envelopeId) || null;
}

// ——— Compile and sign ———

const TABLE_TEXT = 8.5;
const BROKER_FIELDS = /^sig\.broker_reviewer\.(name|date|signature)$/;

async function packFonts(doc, entity) {
  return {
    font: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    theme: packTheme(entity),
  };
}

/**
 * The filled pack's Parts, from Part A on ("How to use this pack" is for whoever fills it in), and from
 * the template's own cover its standard ("Higher Standard · for use with Terms of Business UN-HS 1.6")
 * and pack version ("DD-HS 1.1").
 */
function packBlocks(filledDocx) {
  const { blocks, cover } = docxBlocks(filledDocx);
  const first = blocks.findIndex((block) => block.type === "heading" && /^PART [A-Z]\b/.test(block.text));
  const standard = cover.find((line) => /for use with/i.test(line)) || "";
  const version = cover.map((line) => line.match(/(?:Pack version\s+|·\s*)((?:[A-Z]+-)?DD-[A-Z]{2}\s*[\d.]+)\s*$/)?.[1]).find(Boolean) || "";
  return { blocks: first > 0 ? blocks.slice(first) : blocks, standard, version };
}

function drawSignature(page, image, place) {
  const scale = Math.min(Math.min(170, place.w) / image.width, Math.min(30, SIGNATURE_MAX_HEIGHT) / image.height, 1);
  page.drawImage(image, { x: place.x, y: place.y - 3, width: image.width * scale, height: image.height * scale });
}

/**
 * The pack in the app's own layout: the broker's front cover with the pack's details, Parts A–K in the
 * template's wording, the annexes after an index, page frames numbered through, then the back cover.
 * Returns the PDF and where Part K's reviewer name, dates and signature go.
 */
async function buildPackPdf(envelope, filledDocx, { byRole, annexes, contractorSignature, generatedOn }) {
  const entity = brokerRow(envelope.entity_id);
  const brand = resolveBrandPack(envelope.entity_id);
  const details = coverDetails(envelope, byRole, entity, "Due diligence pack");
  const brokerName = entity.display_name || "the broker";
  const brokerLegal = brokerLegalName(entity) || brokerName;
  const { blocks, standard, version } = packBlocks(filledDocx);

  const out = await PDFDocument.create();
  const fonts = await packFonts(out, entity);
  let logo = null;
  if (brand.logo) {
    try {
      logo = await embedLogoImage(out, brand.logo);
    } catch {
      logo = null;
    }
  }
  const cover = {
    title: "DUE DILIGENCE PACK",
    subtitle: "",
    brand: brokerName.toUpperCase(),
    packTitle: "Due Diligence & Onboarding Pack",
    forUse: standard,
    parties: [
      ["Contractor", details.contractor || "—"],
      ["Client", details.client || "—"],
      ["Pack reference", details.reference],
    ],
    legal: [
      brokerLegal,
      ...(entity.company_number ? [`Company number ${entity.company_number}`] : []),
      ...(entity.registered_office ? [`Registered office: ${entity.registered_office}`] : []),
    ],
    meta: [
      ["Prepared", generatedOn],
      ...(version ? [["Pack version", version]] : []),
    ],
    fill: {
      tokens: coverTokens(details, entity, { brokerLegal, document: "Due Diligence Pack", prepared: generatedOn }),
      fields: {
        title: "Due diligence pack",
        kicker: "DUE DILIGENCE PACK",
        subtitle: "[Shape] contract · [Party roles]",
        summary: standard ? `${standard}.` : "",
      },
      rows: [
        ["Client", details.client || "—"],
        ["Contractor", details.contractor || "—"],
        ["Broker", brokerLegal],
        ["Reference", details.reference, true],
        ["Prepared", generatedOn],
        ...(version ? [["Pack version", version]] : []),
      ],
    },
  };
  if (!(await addBrandedCover(out, brand.front, fonts, cover))) addPlainCover(out, fonts, cover, logo);

  const bodyStart = out.getPageCount();
  const writer = new PackWriter(out, fonts);
  writer.newPage();
  const places = renderBlocks(writer, blocks);
  const image = await out.embedPng(contractorSignature);
  for (const place of places.filter((item) => item.token === "sig.contractor_director.signature")) drawSignature(out.getPage(place.page), image, place);
  const bodyEnd = out.getPageCount();

  const footer = `Due Diligence Pack ${details.reference.split("-")[1] || ""}, Pack reference ${details.reference}`;
  if (annexes.length) await appendBoundAttachments(out, envelope, annexes, { reference: details.reference, firstPage: bodyEnd + 1, footer });
  const wordmark = wordmarkParts(brokerName);
  for (let index = bodyStart; index < bodyEnd; index += 1) {
    drawFrame(out.getPage(index), { pageNumber: index + 1, theme: fonts.theme, font: fonts.font, bold: fonts.bold, logo, wordmark, footer });
  }
  await addBrandedBackCover(
    out,
    brand.back,
    fonts,
    { name: brokerLegal, companyNumber: entity.company_number || "", registeredOffice: entity.registered_office || "" },
    cover.fill
  );
  return { bytes: Buffer.from(await out.save()), places: places.filter((place) => BROKER_FIELDS.test(place.token)) };
}

/**
 * Fills the pack's wording from the form and the records, lays it out with the broker's covers, signs
 * Part J with the contractor's saved signature, and adds every upload as a numbered annex. Where Part K's
 * reviewer name, dates and signature go is kept, so the broker's signing changes nothing else.
 */
export async function compileWordPack(envelopeId, actor = "staff") {
  const { envelope, context } = editableEnvelope(envelopeId);
  const { template, outline, people, pack, values, counts } = context;
  const { contractor, record, byRole } = people;
  const signedOn = pack.signedOn || localDay();
  const gaps = certificateGaps(contractor, record, signedOn);
  if (gaps.length) throw new Error(`Before compiling: ${gaps.join("; ")}`);
  const signature = readPartySignature(record.id);
  if (!signature) throw new Error(`Add ${contractor.signer_name}’s saved signature on the contractor’s record (Part J)`);

  const generatedOn = ukDate(localDay());
  const fixed = fixedValues(envelope, brokerRow(envelope.entity_id), byRole, generatedOn);
  const conditions = { "engagement.cis_in_scope": envelope.payment_models === "paye_cis" };

  const attached = packFiles(envelopeId);
  const annexes = [];
  const annexText = {};
  for (const { key } of evidenceKeys(outline, counts, conditions)) {
    const files = filesForKey(envelopeId, record, key, attached);
    if (!files.length) continue;
    const first = annexes.length + 1;
    for (const file of files) {
      annexes.push({ document: `${fileLabel(key)}, ${ukDate(file.created_at)}`, bytes: readBytes(file.storage_ref) });
    }
    annexText[key] = files.length > 1 ? `Annexes ${first}–${annexes.length}` : `Annex ${first}`;
  }

  const data = {};
  for (const [key, value] of Object.entries({ ...values, ...fixed })) {
    data[key] = typeof value === "string" && isDateField(rowFree(key)) && ISO_DAY.test(value) ? ukDate(value) : value;
  }
  for (const group of groupsOf(outline)) {
    const rows = Array.from({ length: counts[group.arrays[0]] ?? 0 }, () => ({}));
    for (const array of group.arrays) data[array] = rows;
  }
  const filled = fillDocx(readBytes(template.docx_ref), {
    values: data,
    answers: data,
    conditions,
    uploads: (key) => annexText[key] || null,
    images: (key) => annexText[key] || null,
    signatures: {
      "sig.contractor_director.name": contractor.signer_name,
      "sig.contractor_director.position": positionLabel(contractor.signer_role),
      "sig.contractor_director.date": ukDate(signedOn),
    },
    plainAnswers: true,
  });
  const { bytes, places } = await buildPackPdf(envelope, filled, { byRole, annexes, contractorSignature: signature, generatedOn });
  const build = { places };
  const stored = writeBytes("diligence", `${envelopeId}-due-diligence.pdf`, bytes);
  db.prepare(
    `UPDATE envelopes
     SET dd_compiled_at = ?, dd_storage_ref = ?, dd_sha256 = ?, dd_pack_build = ?, dd_back_pages = NULL, dd_cert_page = NULL,
         dd_cert_top = NULL, dd_validated_at = NULL, dd_validated_by = NULL, dd_signed_name = NULL, dd_signed_ip = NULL,
         dd_signature_ref = NULL, pack_template_id = ?
     WHERE id = ?`
  ).run(now(), stored.storageRef, stored.sha256, JSON.stringify(build), template.id, envelopeId);
  if (!pack.signedOn) writePack(envelopeId, { ...pack, signedOn });
  appendEvent({ envelopeId, actor, eventType: "dd_compiled", metadata: { file_hash: stored.sha256, documents: annexes.length } });
  return wordPackState(envelopeId);
}

/** The broker signs Part K: its name, the date and its signature go where the compiled pack left room for them. */
export async function signWordPack(envelopeId, { partyId, signature, typedName, userAgent }) {
  const envelope = db.prepare("SELECT * FROM envelopes WHERE id = ?").get(envelopeId);
  if (LOCKED.includes(envelope.status)) throw new Error("The due diligence pack is locked once the contract has been issued");
  if (!envelope.dd_storage_ref || !envelope.dd_compiled_at) throw new Error("The due diligence pack is not ready to sign");
  if (envelope.dd_validated_at) throw new Error("The broker has already signed this due diligence pack");
  const build = parse(envelope.dd_pack_build, null);
  if (!build?.places?.some((place) => place.token === "sig.broker_reviewer.signature")) {
    throw new Error("Compile the due diligence pack again before signing it");
  }
  const context = packContext(envelope);
  const gaps = approvalGaps(context.values);
  if (gaps.length) throw new Error(`Before the pack can be signed: ${gaps.join("; ")}`);
  const party = db
    .prepare("SELECT p.*, r.role_key FROM envelope_parties p JOIN template_roles r ON r.id = p.role_id WHERE p.id = ?")
    .get(partyId);
  if (!party || party.envelope_id !== envelopeId || party.role_key !== "agency") throw new Error("Only the broker signs the due diligence pack");
  if (!signature?.dataUrl) throw new Error("Add your signature");
  const signerName = String(typedName || party.signer_name || "").trim();
  if (!signerName) throw new Error("Enter the name you are signing with");

  const sigFile = writeBase64Png("signatures", `dd-${envelopeId}-${Date.now()}.png`, signature.dataUrl);
  const signedAt = now();
  const out = await PDFDocument.load(readBytes(envelope.dd_storage_ref));
  const font = await out.embedFont(StandardFonts.Helvetica);
  const { ink } = packTheme(brokerRow(envelope.entity_id));
  const image = await out.embedPng(readBytes(sigFile.storageRef));
  const text = { name: packText(signerName), date: ukDate(signedAt) };
  for (const place of build.places) {
    const page = out.getPage(place.page);
    const field = place.token.split(".").pop();
    if (field === "signature") drawSignature(page, image, place);
    else page.drawText(text[field], { x: place.x, y: place.y, size: TABLE_TEXT, font, color: ink });
  }
  const stored = writeBytes("diligence", `${envelopeId}-due-diligence.pdf`, Buffer.from(await out.save()));
  db.prepare(
    `UPDATE envelopes
     SET dd_validated_at = ?, dd_validated_by = ?, dd_signed_name = ?, dd_signature_ref = ?, dd_storage_ref = ?, dd_sha256 = ?
     WHERE id = ?`
  ).run(signedAt, partyId, signerName, sigFile.storageRef, stored.storageRef, stored.sha256, envelopeId);
  appendEvent({
    envelopeId,
    partyId,
    actor: "party",
    eventType: "dd_signed",
    metadata: { file_hash: stored.sha256, signer_name: signerName },
    userAgent,
  });
}


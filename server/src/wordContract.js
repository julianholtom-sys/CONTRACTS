import { PDFDocument } from "pdf-lib";
import { contractReference, ukDate } from "./coverStamp.js";
import { contractPartyDetails } from "./documentFields.js";
import { docxTokens, fillDocx } from "./docxTemplate.js";
import { signingFields, tokenPlaces } from "./docxFields.js";
import { brokerLegalName } from "./packLayout.js";
import { readBytes } from "./storage.js";
import { convertDocxToPdf } from "./wordConvert.js";

export const PAYMENT_MODELS = { paye: "PAYE only", paye_cis: "PAYE and CIS" };

export function paymentModelsLabel(key) {
  return PAYMENT_MODELS[key] || "";
}

/** "12.5" → "£12.50". */
export function formatFee(value) {
  const amount = Number(String(value ?? "").replace(/[£,\s]/g, ""));
  if (!String(value ?? "").trim() || !Number.isFinite(amount)) return "";
  return `£${amount.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** The fee as stored: a positive amount in pounds with up to two decimals, or null. */
export function storedFee(value) {
  const text = String(value ?? "").replace(/[£,\s]/g, "");
  if (!text) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(text) || Number(text) <= 0) throw new Error("Enter the contractor fee in pounds, for example 12.50");
  return Number(text).toFixed(2);
}

export function storedPaymentModels(value) {
  if (value == null || value === "") return null;
  if (!PAYMENT_MODELS[value]) throw new Error("Choose PAYE only, or PAYE and CIS");
  return value;
}

/** What a Word contract asks to be entered for each contract, beyond the parties. */
export function wordContractNeeds(template) {
  if (!template?.docx_ref) return [];
  const fields = docxTokens(readBytes(template.docx_ref)).fields;
  return [
    ...(fields.has("engagement.contractor_fee") ? ["contractor_fee"] : []),
    ...(fields.has("engagement.payment_models") ? ["payment_models"] : []),
  ];
}

export function missingEngagement(envelope, template) {
  const missing = [];
  for (const need of wordContractNeeds(template)) {
    if (need === "contractor_fee" && !envelope.contractor_fee) missing.push("the contractor fee");
    if (need === "payment_models" && !envelope.payment_models) missing.push("the payment models (PAYE only, or PAYE and CIS)");
  }
  return missing;
}

function companyValues(party) {
  if (!party) return {};
  return {
    legal_name: party.company_name || "",
    registered_office: party.registered_office || "",
    company_number: party.company_number || "",
  };
}

/** The contract's Word template filled from the records, as a PDF, with the signing boxes its {{sig.*}} fields mark. */
export async function buildWordContract({ envelope, template, entity, issuedOn = null }) {
  const missing = missingEngagement(envelope, template);
  if (missing.length) throw new Error(`Enter ${missing.join(" and ")} on the contract first`);
  const byRole = Object.fromEntries(contractPartyDetails(envelope.id).map((party) => [party.role_key, party]));
  const reference = contractReference(envelope, "CT");
  const brokerName = brokerLegalName(entity) || entity.display_name;
  const values = {
    client: companyValues(byRole.company),
    contractor: companyValues(byRole.supplier),
    supplier: companyValues(byRole.spv),
    broker: {
      legal_name: brokerName,
      company_number: entity.company_number || "",
      registered_office: entity.registered_office || "",
      vat_number: entity.vat_number || "",
      notices_contact: brokerName,
    },
    engagement: {
      contractor_fee: formatFee(envelope.contractor_fee),
      payment_models: paymentModelsLabel(envelope.payment_models),
    },
    doc: {
      id: reference,
      reference,
      created_date: ukDate(envelope.prepared_on),
      issued_date: issuedOn ? ukDate(issuedOn) : "",
    },
  };
  const filled = fillDocx(readBytes(template.docx_ref), { values });
  const { pdf, markedPdf } = await convertDocxToPdf(filled, { marked: true });
  const [clean, marked] = await Promise.all([PDFDocument.load(pdf), PDFDocument.load(markedPdf)]);
  if (clean.getPageCount() !== marked.getPageCount()) {
    throw new Error("The contract's pages moved when its signature fields were taken out. Check the Word template.");
  }
  return { pdf, fields: signingFields(await tokenPlaces(markedPdf)), reference };
}

/** A Word template as uploaded, shown with its fields: the system legend removed, room made for signatures. */
export async function previewWordTemplate(docxBytes) {
  const { markedPdf } = await convertDocxToPdf(fillDocx(docxBytes, { keepTokens: true }), { marked: true });
  return { pdf: markedPdf, fields: signingFields(await tokenPlaces(markedPdf)) };
}

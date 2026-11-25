import { rgb } from "pdf-lib";

export function contractReference(envelope, kind) {
  const year = String(envelope?.prepared_on || "").slice(0, 4) || String(new Date().getFullYear());
  const tail = String(envelope?.id || "")
    .replace(/-/g, "")
    .slice(0, 6)
    .toUpperCase();
  return `${kind}-${year}-${tail}`;
}

export function coverDetails(envelope, parties, entity, title) {
  const brokerBits = [
    entity?.display_name,
    entity?.legal_name,
    entity?.company_number ? `Company number ${entity.company_number}` : "",
  ].filter(Boolean);
  return {
    title,
    contractor: parties?.supplier?.company_name || "",
    supplier: parties?.spv?.company_name || "",
    client: parties?.company?.company_name || "",
    reference: contractReference(envelope, title === "Due diligence pack" ? "DD" : "CT"),
    broker: brokerBits.join(" · "),
    brokerOffice: entity?.registered_office || "",
    version: envelope?.party_shape === "four" ? "4-way" : "3-way",
    prepared: envelope?.prepared_on ? `Prepared ${ukDate(envelope.prepared_on)}` : "",
  };
}

export function ukDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : String(value || "");
}

/** Standard PDF fonts only draw Latin-1; map typographic punctuation first. */
export function pdfText(value) {
  return String(value || "")
    .replace(/[\u2018\u2019\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u2033]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\u00A0/g, " ")
    .replace(/[^\x20-\x7E\xA1-\xFF]/g, " ");
}

const clean = pdfText;

/**
 * Writes the contract-specific lines onto a broker cover.
 * The cover artwork stays as uploaded. These lines change with every contract.
 */
export function stampCoverDetails(page, font, bold, details) {
  const { width } = page.getSize();
  const panelW = Math.min(width - 64, 520);
  const panelH = 156;
  const x = 32;
  const y = 28;
  page.drawRectangle({
    x,
    y,
    width: panelW,
    height: panelH,
    color: rgb(1, 1, 1),
    borderColor: rgb(0, 0.45, 1),
    borderWidth: 1.5,
  });
  const lines = [
    { text: details.title || "Contract", size: 13, weight: bold },
    { text: details.contractor ? `Contractor: ${details.contractor}` : "", size: 10, weight: font },
    { text: details.supplier ? `Supplier: ${details.supplier}` : "", size: 10, weight: font },
    { text: details.client ? `Client: ${details.client}` : "", size: 10, weight: font },
    { text: details.reference ? `Reference: ${details.reference}` : "", size: 10, weight: font },
    { text: details.broker || "", size: 9, weight: font },
    { text: details.brokerOffice || "", size: 8, weight: font },
    { text: [details.version, details.prepared].filter(Boolean).join("  ·  "), size: 8, weight: font },
  ].filter((line) => line.text);
  let cursor = y + panelH - 22;
  for (const line of lines) {
    page.drawText(clean(line.text).slice(0, 110), {
      x: x + 12,
      y: cursor,
      size: line.size,
      font: line.weight,
      color: rgb(0.08, 0.1, 0.14),
    });
    cursor -= line.size + 5;
  }
}

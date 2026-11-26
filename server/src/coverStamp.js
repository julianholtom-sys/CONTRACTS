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

/** Values for a template cover's placeholders ("[Reference]", "[the parties]", ...). */
export function coverTokens(details, entity, { brokerLegal, document, prepared }) {
  const four = details.version === "4-way";
  return {
    "Broker name": entity?.display_name || "",
    "Legal name": entity?.legal_name || "",
    "Company number": entity?.company_number || "",
    "Registered office": entity?.registered_office || "",
    "the parties": four
      ? "the Client, the Contractor, the Supplier and the Broker"
      : "the Client, the Contractor and the Broker",
    Parties: four ? "Client · Contractor · Supplier · Broker" : "Client · Contractor · Broker",
    "Party roles": four ? "Client, Contractor, Supplier & Broker" : "Client, Contractor & Broker",
    Shape: four ? "Four-party" : "Three-party",
    Reference: details.reference,
    Prepared: prepared || "",
    Document: document || "",
    Client: details.client,
    Contractor: details.contractor,
    Supplier: details.supplier,
    Broker: brokerLegal || entity?.display_name || "",
  };
}

export function ukDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : String(value || "");
}

export function stampContractDates(page, font, envelope) {
  const issued = envelope.issued_at ? new Date(envelope.issued_at) : null;
  const line = [
    envelope.prepared_on ? `Prepared ${ukDate(envelope.prepared_on)}` : null,
    issued
      ? `Issued ${String(issued.getDate()).padStart(2, "0")}/${String(issued.getMonth() + 1).padStart(2, "0")}/${issued.getFullYear()}`
      : "Issued on send",
  ]
    .filter(Boolean)
    .join(" · ");
  page.drawText(line, { x: 40, y: 40, size: 8, font, color: rgb(0.25, 0.25, 0.25) });
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

function wrapLine(text, font, size, width) {
  const rows = [];
  let row = "";
  for (const word of clean(text).split(/\s+/).filter(Boolean)) {
    const next = row ? `${row} ${word}` : word;
    if (row && font.widthOfTextAtSize(next, size) > width) {
      rows.push(row);
      row = word;
    } else {
      row = next;
    }
  }
  if (row) rows.push(row);
  return rows;
}

/**
 * Writes the contract-specific lines onto a broker cover that has no details panel of its own.
 * The panel sits in the bottom-right quarter so the cover artwork stays visible.
 */
export function stampCoverDetails(page, font, bold, details) {
  const { width } = page.getSize();
  const x = width / 2 + 8;
  const y = 28;
  const panelW = width - x - 28;
  const pad = 12;
  const lines = [
    { text: details.title || "Contract", size: 12, weight: bold },
    { text: details.contractor ? `Contractor: ${details.contractor}` : "", size: 9, weight: font },
    { text: details.supplier ? `Supplier: ${details.supplier}` : "", size: 9, weight: font },
    { text: details.client ? `Client: ${details.client}` : "", size: 9, weight: font },
    { text: details.reference ? `Reference: ${details.reference}` : "", size: 9, weight: font },
    { text: details.broker || "", size: 7.5, weight: font },
    { text: details.brokerOffice || "", size: 7.5, weight: font },
    { text: [details.version, details.prepared].filter(Boolean).join("  ·  "), size: 7.5, weight: font },
  ]
    .filter((line) => line.text)
    .flatMap((line) => wrapLine(line.text, line.weight, line.size, panelW - pad * 2).map((text) => ({ ...line, text })));
  const panelH = pad * 2 + lines.reduce((sum, line) => sum + line.size + 4, 0);
  page.drawRectangle({
    x,
    y,
    width: panelW,
    height: panelH,
    color: rgb(1, 1, 1),
    borderColor: rgb(0, 0.45, 1),
    borderWidth: 1.5,
  });
  let cursor = y + panelH - pad - lines[0].size;
  for (const line of lines) {
    page.drawText(line.text, {
      x: x + pad,
      y: cursor,
      size: line.size,
      font: line.weight,
      color: rgb(0.08, 0.1, 0.14),
    });
    cursor -= line.size + 4;
  }
}

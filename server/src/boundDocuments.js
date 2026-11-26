import { PDFDocument, StandardFonts } from "pdf-lib";
import { db } from "./db.js";
import { readBytes } from "./storage.js";
import { embedLogoImage, resolveBrandPack } from "./bake.js";
import { contractReference } from "./coverStamp.js";
import { FINAL_EVIDENCE, PARTY_LABELS } from "./parties.js";
import {
  BODY_BOTTOM,
  BODY_TOP,
  CONTENT_W,
  MARGIN,
  PAGE,
  PackWriter,
  drawCaption,
  drawFrame,
  packTheme,
  placeInBody,
  wordmarkParts,
  wrapText,
} from "./packLayout.js";

/** Documents bound in after the signed pack, in sign order: director IDs, and the client's incorporation and VAT certificates. */
export function listSigningAttachments(envelopeId) {
  const parties = db
    .prepare(
      `SELECT p.id, p.company_name, p.signer_name, r.role_key, r.label AS role_label
       FROM envelope_parties p
       JOIN template_roles r ON r.id = p.role_id
       WHERE p.envelope_id = ?
       ORDER BY p.order_index ASC`
    )
    .all(envelopeId);
  const files = db
    .prepare(
      `SELECT f.*, r.requirement_key, r.label
       FROM evidence_files f
       JOIN evidence_requirements r ON r.id = f.requirement_id
       WHERE f.envelope_id = ? AND f.deleted_at IS NULL`
    )
    .all(envelopeId);
  const entries = [];
  for (const party of parties) {
    const keys = (FINAL_EVIDENCE[party.role_key] || []).map(([key]) => key);
    const mine = files
      .filter((file) => file.party_id === party.id && keys.includes(file.requirement_key))
      .sort((a, b) => keys.indexOf(a.requirement_key) - keys.indexOf(b.requirement_key));
    for (const file of mine) {
      entries.push({
        party: PARTY_LABELS[party.role_key] || party.role_label,
        company: party.company_name,
        document:
          file.requirement_key === "director_id" ? `Director ID (${party.signer_name})` : file.label || file.requirement_key,
        bytes: readBytes(file.storage_ref),
      });
    }
  }
  return entries;
}

const isJpeg = (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8;
const isPng = (bytes) =>
  bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

const pageRange = (item) => (item.pages > 1 ? `${item.start}–${item.start + item.pages - 1}` : String(item.start));

/** Leading page, laid out like a pack divider, with the index of the documents after it. */
function addIndexPage(writer, items, reference) {
  const { font, bold, theme } = writer;
  const page = writer.newPage();
  let y = 650;
  const line = (text, size, face, color, gap) => {
    for (const row of wrapText(text, face, size, CONTENT_W)) {
      page.drawText(row, { x: MARGIN, y, size, font: face, color });
      y -= size + gap;
    }
  };
  line(items.length === 1 ? "DOCUMENT 1" : `DOCUMENTS 1–${items.length}`, 9, bold, theme.muted, 24);
  line("DOCUMENTS PROVIDED AT SIGNING", 26, bold, theme.accent, 10);
  line(`Contract reference ${reference}`, 10, font, theme.muted, 6);
  page.drawRectangle({ x: MARGIN, y: y - 4, width: 80, height: 3, color: theme.accent });
  writer.y = y - 30;
  writer.table(
    [
      { label: "Document", width: CONTENT_W - 230 },
      { label: "Party", width: 180 },
      { label: "Pages", width: 50, align: "center" },
    ],
    items.map((item, index) => [`Document ${index + 1}: ${item.document}`, `${item.party}: ${item.company}`, pageRange(item)]),
    { size: 8 }
  );
}

async function addDocumentPages(pdf, item, caption, fonts) {
  const bottom = BODY_BOTTOM + 4;
  if (item.note) {
    const page = pdf.addPage([PAGE.w, PAGE.h]);
    drawCaption(page, fonts, caption);
    page.drawText(item.note, { x: MARGIN, y: BODY_TOP - 40, size: 9, font: fonts.font, color: fonts.theme.ink });
    return;
  }
  if (item.image) {
    const page = pdf.addPage([PAGE.w, PAGE.h]);
    drawCaption(page, fonts, caption);
    const image = isJpeg(item.bytes) ? await pdf.embedJpg(item.bytes) : await pdf.embedPng(item.bytes);
    placeInBody(page, image, { top: BODY_TOP - 22, bottom, rule: fonts.theme.rule });
    return;
  }
  const indices = item.src.getPageIndices();
  let embedded;
  try {
    embedded = await pdf.embedPdf(item.src, indices);
  } catch {
    const copies = await pdf.copyPages(item.src, indices);
    copies.forEach((page) => pdf.addPage(page));
    return;
  }
  embedded.forEach((source, n) => {
    const page = pdf.addPage([PAGE.w, PAGE.h]);
    drawCaption(page, fonts, caption, n > 0);
    placeInBody(page, source, {
      top: n === 0 ? BODY_TOP - 22 : BODY_TOP - 18,
      bottom,
      rotation: item.src.getPage(indices[n]).getRotation().angle,
      rule: fonts.theme.rule,
    });
  });
}

/** Binds the documents in with the broker's page frame, an index page and captions, like the pack's annexes. */
export async function appendBoundAttachments(pdf, envelope, entries) {
  if (!entries.length) return;
  const entity = db.prepare("SELECT * FROM entities WHERE id = ?").get(envelope.entity_id);
  const theme = packTheme(entity);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const fonts = { font, bold, theme };
  const brand = resolveBrandPack(envelope.entity_id);
  let logo = null;
  if (brand.logo) {
    try {
      logo = await embedLogoImage(pdf, brand.logo);
    } catch {
      logo = null;
    }
  }

  const items = [];
  let pageNumber = 2;
  for (const entry of entries) {
    const bytes = Buffer.from(entry.bytes);
    const item = { ...entry, bytes, pages: 1 };
    if (bytes.subarray(0, 5).toString() === "%PDF-") {
      try {
        item.src = await PDFDocument.load(bytes);
        item.pages = item.src.getPageCount();
      } catch {
        item.note = "This PDF could not be embedded. The original file is kept with the contract record.";
      }
    } else if (isJpeg(bytes) || isPng(bytes)) {
      item.image = true;
    } else {
      item.note = "The original file is kept with the contract record.";
    }
    item.start = pageNumber;
    pageNumber += item.pages;
    items.push(item);
  }

  const reference = contractReference(envelope, "CT");
  const first = pdf.getPageCount();
  addIndexPage(new PackWriter(pdf, fonts), items, reference);
  for (const [index, item] of items.entries()) {
    await addDocumentPages(pdf, item, `Document ${index + 1}: ${item.party}, ${item.document}`, fonts);
  }

  const footer = `Documents provided at signing, Contract reference ${reference}`;
  const wordmark = wordmarkParts(entity?.display_name || "");
  for (let index = first; index < pdf.getPageCount(); index += 1) {
    drawFrame(pdf.getPage(index), {
      pageNumber: index - first + 1,
      theme,
      font,
      bold,
      logo,
      wordmark,
      footer,
      watermark: index === first,
    });
  }
}

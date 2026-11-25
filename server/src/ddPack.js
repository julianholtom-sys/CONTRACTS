import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { db } from "./db.js";
import { readBytes } from "./storage.js";
import { embedLogoImage, resolveBrandPack } from "./bake.js";
import { coverDetails, pdfText, ukDate } from "./coverStamp.js";
import { packSources, registryBundle } from "./partyRecords.js";

function wrap(text, width) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > width) {
      if (current) lines.push(current);
      current = word;
    } else current = next;
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

export async function buildDueDiligencePdf(envelopeId) {
  const envelope = db.prepare("SELECT * FROM envelopes WHERE id = ?").get(envelopeId);
  const entity = db.prepare("SELECT * FROM entities WHERE id = ?").get(envelope.entity_id);
  const sources = packSources(envelopeId);
  const brand = resolveBrandPack(envelope.entity_id);
  const details = coverDetails(envelope, sources.byRole, entity, "Due diligence pack");

  const narrative = await PDFDocument.create();
  const font = await narrative.embedFont(StandardFonts.Helvetica);
  const bold = await narrative.embedFont(StandardFonts.HelveticaBold);
  const template = envelope.template_id
    ? db.prepare("SELECT name FROM templates WHERE id = ?").get(envelope.template_id)
    : null;
  await addCover(narrative, brand.logo, font, bold, details, entity, template?.name || "");
  writeNarrative(narrative, font, bold, envelope, entity, sources, details);

  const attachments = [];
  for (const doc of sources.documents) {
    if (doc.virtual) {
      attachments.push({ doc, pages: 1, virtual: true });
      continue;
    }
    const bytes = readBytes(doc.storageRef);
    const isPdf = bytes.slice(0, 5).toString() === "%PDF-";
    if (isPdf) {
      const src = await PDFDocument.load(bytes);
      attachments.push({ doc, bytes, pages: src.getPageCount(), virtual: false });
    } else {
      attachments.push({ doc, bytes, pages: 1, virtual: false, image: true });
    }
  }

  const indexPages = indexPagesNeeded(indexRows(attachments).length);
  const placed = placeAttachments(narrative.getPageCount(), indexPages, attachments);

  const index = await PDFDocument.create();
  const indexFont = await index.embedFont(StandardFonts.Helvetica);
  const indexBold = await index.embedFont(StandardFonts.HelveticaBold);
  writeIndex(index, indexFont, indexBold, placed);

  const out = await PDFDocument.create();
  const copiedNarrative = await out.copyPages(narrative, narrative.getPageIndices());
  copiedNarrative.forEach((page) => out.addPage(page));
  const copiedIndex = await out.copyPages(index, index.getPageIndices());
  copiedIndex.forEach((page) => out.addPage(page));
  for (const item of placed) {
    if (item.virtual) {
      await addVirtualPage(out, item);
    } else if (item.image) {
      await addImagePage(out, item);
    } else {
      const src = await PDFDocument.load(item.bytes);
      const pages = await out.copyPages(src, src.getPageIndices());
      pages.forEach((page) => out.addPage(page));
    }
  }
  const backPages = await addBackCover(out, brand.back);
  return { bytes: Buffer.from(await out.save()), backPages };
}

function placeAttachments(narrativePages, indexPages, attachments) {
  let page = narrativePages + indexPages + 1;
  return attachments.map((item) => {
    const start = page;
    page += item.pages;
    return { ...item, start };
  });
}

/** The pack has its own cover; the broker's contract cover is for the contract. */
async function addCover(doc, logo, font, bold, details, entity, templateName) {
  const page = doc.addPage([595.28, 841.89]);
  const accent = rgb(0, 0.45, 1);
  const ink = rgb(0.08, 0.1, 0.14);
  const muted = rgb(0.32, 0.36, 0.42);
  const brokerName = entity?.display_name || "the broker";
  let y = 760;
  if (logo) {
    try {
      const image = await embedLogoImage(doc, logo);
      const height = 64;
      const width = (image.width / image.height) * height;
      page.drawImage(image, { x: 56, y: y - height, width, height });
      y -= height + 36;
    } catch {
      y -= 12;
    }
  }
  const text = (value, { size = 12, weight = font, color = ink, gap = 8 } = {}) => {
    for (const row of wrap(value, Math.floor(1000 / size))) {
      page.drawText(pdfText(row), { x: 56, y, size, font: weight, color });
      y -= size + gap;
    }
  };
  text(brokerName.toUpperCase(), { size: 14, weight: bold, color: accent, gap: 18 });
  text("Due Diligence", { size: 32, weight: bold, gap: 6 });
  text("& Onboarding Pack", { size: 32, weight: bold, gap: 18 });
  text(`For use with the ${brokerName} ${templateName || "contract"}`, { size: 12, color: muted, gap: 30 });
  page.drawRectangle({ x: 56, y: y + 14, width: 80, height: 3, color: accent });
  y -= 14;
  if (details.contractor) text(`Contractor: ${details.contractor}`, { size: 13, weight: bold });
  if (details.supplier) text(`Supplier: ${details.supplier}`, { size: 13, weight: bold });
  if (details.client) text(`Client: ${details.client}`, { size: 13, weight: bold });
  y -= 6;
  text(`Pack reference: ${details.reference}`, { size: 12, gap: 34 });

  text(brokerName, { size: 11, weight: bold, gap: 5 });
  if (entity?.legal_name && entity.legal_name !== brokerName) text(entity.legal_name, { size: 10, color: muted, gap: 5 });
  if (entity?.company_number) text(`Company number: ${entity.company_number}`, { size: 10, color: muted, gap: 5 });
  if (entity?.registered_office) text(`Registered office: ${entity.registered_office}`, { size: 10, color: muted, gap: 5 });

  const year = details.reference.split("-")[1] || "";
  page.drawText(pdfText(`${year} · ${details.version} contract${details.prepared ? ` · ${details.prepared}` : ""}`), {
    x: 56,
    y: 72,
    size: 10,
    font,
    color: muted,
  });
  page.drawText(pdfText(`Doc ID: ${details.reference}`), { x: 56, y: 56, size: 10, font, color: muted });
}

async function addBackCover(out, back) {
  if (!back) return 0;
  const bytes = readBytes(back.storage_ref);
  const isPdf = (back.mime || "").includes("pdf") || back.storage_ref.endsWith(".pdf");
  if (isPdf) {
    const src = await PDFDocument.load(bytes);
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((page) => out.addPage(page));
    return pages.length;
  }
  const page = out.addPage([595.28, 841.89]);
  const image = bytes[0] === 0xff ? await out.embedJpg(bytes) : await out.embedPng(bytes);
  page.drawImage(image, { x: 0, y: 0, width: 595.28, height: 841.89 });
  return 1;
}

function writeNarrative(doc, font, bold, envelope, entity, sources, details) {
  const cursor = { y: 0, page: null };
  const fresh = () => {
    cursor.page = doc.addPage([595.28, 841.89]);
    cursor.y = 790;
    cursor.page.drawText("DUE DILIGENCE PACK", {
      x: 48,
      y: cursor.y,
      size: 9,
      font: bold,
      color: rgb(0, 0.45, 1),
    });
    cursor.y -= 22;
  };
  const line = (text, { size = 11, weight = font, gap = 5, indent = 48 } = {}) => {
    for (const row of wrap(text, 88)) {
      if (cursor.y < 64) fresh();
      cursor.page.drawText(pdfText(row), {
        x: indent,
        y: cursor.y,
        size,
        font: weight,
        color: rgb(0.1, 0.12, 0.16),
      });
      cursor.y -= size + gap;
    }
  };
  fresh();
  line(details.reference, { size: 10, weight: bold });
  line(`Prepared for ${details.client || "the client"} on behalf of ${entity?.display_name || "the broker"}.`);
  line(
    "Companies House filings are fetched from the company number. The UK Sanctions List is searched for the company and its directors. The broker records the date each document was received and the date it was checked. Those dates belong to this contract."
  );
  cursor.y -= 8;
  line("Pack details", { size: 14, weight: bold });
  line(`Broker: ${details.broker}`);
  if (details.brokerOffice) line(details.brokerOffice);
  line(`Contractor: ${details.contractor || "—"}`);
  if (details.supplier) line(`Supplier: ${details.supplier}`);
  line(`Client: ${details.client || "—"}`);
  line(details.version);

  for (const record of sources.records) {
    const bundle = record.directoryId ? registryBundle(record.directoryId) : null;
    const profile = bundle?.profile || {};
    cursor.y -= 8;
    line(`${record.label} — ${record.companyName}`, { size: 14, weight: bold });
    line(`Company number ${profile.companyNumber || record.companyNumber || "—"}`);
    line(`Status: ${profile.status || "—"} · Incorporated ${profile.incorporatedOn || "—"}`);
    line(`Registered office: ${profile.registeredOffice || "—"}`);
    for (const previous of profile.previousNames || []) {
      line(`Previously ${previous.name}${previous.period ? ` (${previous.period})` : ""}`);
    }
    if (profile.accounts) line(`Accounts: ${profile.accounts}`);
    if (profile.confirmationStatement) line(`Confirmation statement: ${profile.confirmationStatement}`);
    const officers = bundle?.officers || [];
    line(officers.length ? "Directors and other officers" : "No officers were returned", {
      size: 12,
      weight: bold,
    });
    for (const officer of officers) {
      line(
        [
          officer.name,
          officer.role,
          officer.status,
          officer.appointedOn ? `appointed ${officer.appointedOn}` : "",
          officer.resignedOn ? `resigned ${officer.resignedOn}` : "",
        ]
          .filter(Boolean)
          .join(" · ")
      );
    }
    const pscs = bundle?.pscs || [];
    if (pscs.length) {
      line("People with significant control", { size: 12, weight: bold });
      for (const person of pscs) {
        line(
          [
            person.name,
            person.status,
            person.notifiedOn ? `notified ${person.notifiedOn}` : "",
            person.ceasedOn ? `ceased ${person.ceasedOn}` : "",
          ]
            .filter(Boolean)
            .join(" · ")
        );
        if (person.natureOfControl) line(person.natureOfControl, { size: 10 });
      }
    }
    const sanctions = bundle?.sanctions;
    if (sanctions) {
      line("UK Sanctions List", { size: 12, weight: bold });
      line(
        sanctions.hitCount
          ? `${sanctions.hitCount} possible match${sanctions.hitCount === 1 ? "" : "es"} on the list dated ${sanctions.listedOn || "the latest publication"}.`
          : `No match on the list dated ${sanctions.listedOn || "the latest publication"}.`
      );
    }
  }

  cursor.y -= 8;
  line("Broker verification", { size: 14, weight: bold });
  line(
    "The annex index that follows lists every document in this pack, the page it starts on, the date the broker received it and the date the broker checked it for this client."
  );
  void envelope;
}

function annexLetter(index) {
  let n = index;
  let label = "";
  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return label;
}

const INDEX_TOP = 790;
const INDEX_BOTTOM = 56;
const INDEX_ROW = 15;
const INDEX_FIRST_PAGE_HEADER = 4;

/** One row per document plus one heading row each time the company changes. */
function indexRows(placed) {
  const rows = [];
  let group = "";
  placed.forEach((item, index) => {
    const heading = `${item.doc.roleLabel} - ${item.doc.companyName}`;
    if (heading !== group) {
      rows.push({ heading });
      group = heading;
    }
    rows.push({ item, letter: annexLetter(index) });
  });
  return rows;
}

function indexPagesNeeded(rowCount) {
  const perPage = Math.floor((INDEX_TOP - INDEX_BOTTOM) / INDEX_ROW);
  const first = perPage - INDEX_FIRST_PAGE_HEADER;
  return rowCount <= first ? 1 : 1 + Math.ceil((rowCount - first) / perPage);
}

function fitText(font, text, size, width) {
  let value = pdfText(text);
  if (font.widthOfTextAtSize(value, size) <= width) return value;
  while (value.length > 1 && font.widthOfTextAtSize(`${value}...`, size) > width) value = value.slice(0, -1);
  return `${value.trimEnd()}...`;
}

function writeIndex(doc, font, bold, placed) {
  const ink = rgb(0.1, 0.12, 0.16);
  const muted = rgb(0.38, 0.42, 0.48);
  const cols = { letter: 48, label: 80, page: 392, received: 440, checked: 500 };
  const rows = indexRows(placed);
  let page = null;
  let y = 0;
  const header = () => {
    for (const [key, text] of [
      ["letter", "Annex"],
      ["label", "Document"],
      ["page", "Page"],
      ["received", "Received"],
      ["checked", "Checked"],
    ]) {
      page.drawText(text, { x: cols[key], y, size: 8, font: bold, color: muted });
    }
    y -= INDEX_ROW;
  };
  const fresh = (first) => {
    page = doc.addPage([595.28, 841.89]);
    y = INDEX_TOP;
    if (first) {
      page.drawText("Annex evidence index", { x: 48, y, size: 16, font: bold, color: ink });
      y -= 22;
      page.drawText("Page numbers are pages of this pack. Dates are when the broker received and checked each document.", {
        x: 48,
        y,
        size: 9,
        font,
        color: muted,
      });
      y -= 22;
    }
    header();
  };
  fresh(true);
  for (const row of rows) {
    if (y < INDEX_BOTTOM) fresh(false);
    if (row.heading) {
      page.drawText(fitText(bold, row.heading, 10, 500), { x: 48, y, size: 10, font: bold, color: rgb(0, 0.45, 1) });
      y -= INDEX_ROW;
      continue;
    }
    const { item, letter } = row;
    const end = item.start + item.pages - 1;
    const pages = end > item.start ? `${item.start}-${end}` : String(item.start);
    page.drawText(letter, { x: cols.letter, y, size: 9, font: bold, color: ink });
    page.drawText(fitText(font, item.doc.label, 9, cols.page - cols.label - 10), {
      x: cols.label,
      y,
      size: 9,
      font,
      color: ink,
    });
    page.drawText(pages, { x: cols.page, y, size: 9, font, color: ink });
    page.drawText(ukDate(item.doc.receivedOn) || "-", { x: cols.received, y, size: 9, font, color: ink });
    page.drawText(ukDate(item.doc.checkedOn) || "-", { x: cols.checked, y, size: 9, font, color: ink });
    y -= INDEX_ROW;
  }
}

async function addVirtualPage(doc, item) {
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([595.28, 841.89]);
  const bundle = registryBundle(item.doc.partyId);
  page.drawText(pdfText(item.doc.label).slice(0, 90), {
    x: 48,
    y: 790,
    size: 14,
    font: bold,
    color: rgb(0.1, 0.12, 0.16),
  });
  page.drawText(pdfText(item.doc.companyName), {
    x: 48,
    y: 768,
    size: 11,
    font,
    color: rgb(0.2, 0.24, 0.3),
  });
  let y = 740;
  const rows =
    item.doc.virtual === "sanctions"
      ? sanctionLines(bundle?.sanctions)
      : (bundle?.officers || []).map((officer) =>
          [
            officer.name,
            officer.role,
            officer.status,
            officer.nationality,
            officer.appointedOn ? `appointed ${officer.appointedOn}` : "",
            officer.resignedOn ? `resigned ${officer.resignedOn}` : "",
          ]
            .filter(Boolean)
            .join(" · ")
        );
  for (const row of rows.length ? rows : ["Nothing further was returned."]) {
    for (const line of wrap(row, 88)) {
      page.drawText(pdfText(line), { x: 48, y, size: 10, font, color: rgb(0.1, 0.12, 0.16) });
      y -= 14;
    }
  }
}

function sanctionLines(sanctions) {
  if (!sanctions) return ["The sanctions search has not been run."];
  const query = sanctions.query || {};
  const lines = [
    `UK Sanctions List published ${sanctions.listedOn || "-"}. Searched ${ukDate(sanctions.searchedAt)}.`,
    `Source: ${sanctions.listUrl || "https://sanctionslist.fcdo.gov.uk/"}`,
    "",
    "Names and numbers searched",
    query.companyName ? `Company: ${query.companyName}` : "",
    query.companyNumber ? `Company number: ${query.companyNumber}` : "",
    ...(query.previousNames || []).map((name) => `Previous name: ${name}`),
    ...(query.people || []).map((name) => `Director or PSC: ${name}`),
    "",
    sanctions.hitCount
      ? `Result: ${sanctions.hitCount} possible match${sanctions.hitCount === 1 ? "" : "es"} for the broker to review.`
      : "Result: no match.",
  ].filter((line, index, all) => line || (index > 0 && all[index - 1]));
  for (const hit of sanctions.hits || []) {
    lines.push(`${hit.name} - ${hit.regime} - matched on ${hit.matchedOn.join(", ")}`);
  }
  return lines;
}

async function addImagePage(doc, item) {
  const page = doc.addPage([595.28, 841.89]);
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  page.drawText(pdfText(item.doc.label).slice(0, 90), { x: 48, y: 800, size: 12, font });
  const image = item.bytes[0] === 0xff ? await doc.embedJpg(item.bytes) : await doc.embedPng(item.bytes);
  const scale = Math.min(500 / image.width, 720 / image.height, 1);
  const w = image.width * scale;
  const h = image.height * scale;
  page.drawImage(image, { x: 48, y: 760 - h, width: w, height: h });
}

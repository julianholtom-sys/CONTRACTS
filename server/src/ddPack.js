import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { db } from "./db.js";
import { readBytes } from "./storage.js";
import { resolveBrandPack } from "./bake.js";
import { coverDetails, stampCoverDetails } from "./coverStamp.js";
import { packSources, registryBundle } from "./partyRecords.js";

function pdfText(value) {
  return String(value || "").replace(/[^\x20-\x7E]/g, " ");
}

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
  await addCover(narrative, brand.front, font, bold, details);
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

  let indexPages = 1;
  let placed = placeAttachments(narrative.getPageCount(), indexPages, attachments);
  if (placed.length > 32) {
    indexPages = 2;
    placed = placeAttachments(narrative.getPageCount(), indexPages, attachments);
  }

  const index = await PDFDocument.create();
  const indexFont = await index.embedFont(StandardFonts.Helvetica);
  const indexBold = await index.embedFont(StandardFonts.HelveticaBold);
  writeIndex(index, indexFont, indexBold, placed, indexPages);

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
  return Buffer.from(await out.save());
}

function placeAttachments(narrativePages, indexPages, attachments) {
  let page = narrativePages + indexPages + 1;
  return attachments.map((item) => {
    const start = page;
    page += item.pages;
    return { ...item, start };
  });
}

async function addCover(doc, front, font, bold, details) {
  if (front) {
    const bytes = readBytes(front.storage_ref);
    const isPdf = (front.mime || "").includes("pdf") || front.storage_ref.endsWith(".pdf");
    if (isPdf) {
      const src = await PDFDocument.load(bytes);
      const pages = await doc.copyPages(src, src.getPageIndices());
      pages.forEach((page) => doc.addPage(page));
      stampCoverDetails(doc.getPages()[0], font, bold, details);
      return;
    }
    const page = doc.addPage([595.28, 841.89]);
    const image = bytes[0] === 0xff ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
    page.drawImage(image, { x: 0, y: 0, width: 595.28, height: 841.89 });
    stampCoverDetails(page, font, bold, details);
    return;
  }
  const page = doc.addPage([595.28, 841.89]);
  page.drawText(pdfText(details.broker || "Contract Builder"), {
    x: 48,
    y: 780,
    size: 16,
    font: bold,
    color: rgb(0, 0.45, 1),
  });
  stampCoverDetails(page, font, bold, details);
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
    if (profile.accounts) line(`Accounts: ${profile.accounts}`);
    if (profile.confirmationStatement) line(`Confirmation statement: ${profile.confirmationStatement}`);
    const officers = bundle?.officers || [];
    line(officers.length ? "Directors and other officers" : "No officers were returned", {
      size: 12,
      weight: bold,
    });
    for (const officer of officers) {
      line(
        [officer.name, officer.role, officer.status, officer.appointedOn ? `appointed ${officer.appointedOn}` : ""]
          .filter(Boolean)
          .join(" · ")
      );
    }
    const pscs = bundle?.pscs || [];
    if (pscs.length) {
      line("People with significant control", { size: 12, weight: bold });
      for (const person of pscs) {
        line([person.name, person.status, person.notifiedOn ? `notified ${person.notifiedOn}` : ""].filter(Boolean).join(" · "));
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
  line("Each date is the date the broker received the document and the date they checked it for this client.");
  for (const doc of sources.documents) {
    line(`${doc.label}`, { weight: bold, size: 10 });
    line(`Received ${doc.receivedOn || "—"} · Checked ${doc.checkedOn || "—"}`, { size: 10 });
  }
  cursor.y -= 6;
  line(
    "The director’s certificate is the broker’s record that the contractor’s documents, the supplier’s documents where there is one, and these checks were reviewed before the contract was issued.",
    { size: 10 }
  );
  void envelope;
}

function writeIndex(doc, font, bold, placed, pages) {
  const needed = Math.max(pages, 1);
  for (let i = 0; i < needed; i += 1) {
    const page = doc.addPage([595.28, 841.89]);
    let y = 790;
    const draw = (text, size, weight) => {
      page.drawText(pdfText(text).slice(0, 100), {
        x: 48,
        y,
        size,
        font: weight,
        color: rgb(0.1, 0.12, 0.16),
      });
      y -= size + 6;
    };
    if (i === 0) {
      draw("Annex evidence index", 16, bold);
      draw("Page numbers are the pages of this due diligence pack.", 10, font);
      y -= 6;
    }
    const slice = placed.slice(i * 32, (i + 1) * 32);
    slice.forEach((item, index) => {
      const number = i * 32 + index + 1;
      draw(
        `${number}. ${item.doc.companyName} — ${item.doc.label} · page ${item.start}`,
        10,
        font
      );
    });
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
          [officer.name, officer.role, officer.status, officer.nationality, officer.appointedOn]
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
  const lines = [
    `List dated ${sanctions.listedOn || "—"}. Searched ${String(sanctions.searchedAt || "").slice(0, 10)}.`,
    sanctions.hitCount ? `${sanctions.hitCount} possible match(es).` : "No match.",
  ];
  for (const hit of sanctions.hits || []) {
    lines.push(`${hit.name} · ${hit.regime} · matched on ${hit.matchedOn.join(", ")}`);
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

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
  const letters = Object.fromEntries(sources.documents.map((doc, index) => [doc.key, annexLetter(index)]));
  writeNarrative(narrative, font, bold, sources, details, letters);
  const certPage = addCertificate(narrative, font, bold, {
    entity,
    broker: sources.byRole.agency,
    details,
    sources,
  });

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
      // A Companies House filing's first page is the certificate or notice; the rest is the application and articles.
      const indices = doc.source === "companies_house" ? [0] : src.getPageIndices();
      attachments.push({ doc, bytes, indices, pages: indices.length, virtual: false });
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
      const pages = await out.copyPages(src, item.indices);
      pages.forEach((page) => out.addPage(page));
    }
  }
  const backPages = await addBackCover(out, brand.back);
  return { bytes: Buffer.from(await out.save()), backPages, certPage };
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

function writeNarrative(doc, font, bold, sources, details, letters) {
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
    for (const row of wrap(text, Math.floor(968 / size))) {
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
  cursor.y -= 4;
  line("Pack details", { size: 14, weight: bold });
  line(`Broker: ${details.broker}`);
  if (details.brokerOffice) line(details.brokerOffice);
  line(`Contractor: ${details.contractor || "—"}`);
  if (details.supplier) line(`Supplier: ${details.supplier}`);
  line(`Client: ${details.client || "—"}`);
  line(`Contract: ${details.version}`);

  for (const record of sources.records) {
    const bundle = record.directoryId ? registryBundle(record.directoryId) : null;
    const profile = bundle?.profile || {};
    cursor.y -= 8;
    line(`${record.label} - ${record.companyName}`, { size: 14, weight: bold });
    line(
      `Company number ${profile.companyNumber || record.companyNumber || "—"} · ${profile.status || "—"} · incorporated ${profile.incorporatedOn || "—"}`
    );
    line(`Registered office: ${profile.registeredOffice || "—"}`);
    for (const previous of profile.previousNames || []) {
      line(`Formerly ${previous.name}${previous.period ? ` (${previous.period})` : ""}`);
    }
    if (profile.accounts) {
      line(`Accounts: ${filingStatus(profile.accounts, /Last accounts made up to (\d{1,2} \w+ \d{4})/i, "last made up to")}`);
    }
    if (profile.confirmationStatement) {
      line(
        `Confirmation statement: ${filingStatus(profile.confirmationStatement, /Last statement dated (\d{1,2} \w+ \d{4})/i, "last dated")}`
      );
    }
    const sanctions = bundle?.sanctions;
    if (sanctions) {
      const result = sanctions.hitCount
        ? `${sanctions.hitCount} possible match${sanctions.hitCount === 1 ? "" : "es"}`
        : "no match";
      line(`UK Sanctions List: ${result} (list dated ${sanctions.listedOn || "-"})`);
    }
    const officers = bundle?.officers || [];
    if (officers.length) line("Officers", { size: 11, weight: bold });
    for (const officer of officers) {
      line(
        [
          displayName(officer.name),
          officer.role,
          officer.appointedOn ? `appointed ${officer.appointedOn}` : "",
          officer.resignedOn ? `resigned ${officer.resignedOn}` : "",
        ]
          .filter(Boolean)
          .join(" · "),
        { size: 10 }
      );
    }
    const pscs = bundle?.pscs || [];
    if (pscs.length) line("People with significant control", { size: 11, weight: bold });
    for (const person of pscs) {
      line(
        [
          person.name,
          person.notifiedOn ? `notified ${person.notifiedOn}` : "",
          person.ceasedOn ? `ceased ${person.ceasedOn}` : "",
          shortControl(person.natureOfControl),
        ]
          .filter(Boolean)
          .join(" · "),
        { size: 10 }
      );
    }
  }

  const today = Date.now();
  const facts = sources.records.map((record) => companyFacts(record, sources.documents, letters, today));
  const ink = rgb(0.1, 0.12, 0.16);
  const muted = rgb(0.38, 0.42, 0.48);
  const row = (result, text, annex) => {
    wrap(text, 70).forEach((part, index) => {
      if (cursor.y < 64) fresh();
      if (index === 0) {
        cursor.page.drawText(result, {
          x: 48,
          y: cursor.y,
          size: 10,
          font: bold,
          color: result === "Yes" ? ink : rgb(0.75, 0.1, 0.1),
        });
        if (annex) cursor.page.drawText(annex, { x: 480, y: cursor.y, size: 10, font, color: ink });
      }
      cursor.page.drawText(pdfText(part), { x: 84, y: cursor.y, size: 10, font, color: ink });
      cursor.y -= 15;
    });
  };
  cursor.y -= 8;
  line("Declarations", { size: 14, weight: bold });
  for (const fact of facts) {
    cursor.y -= 4;
    line(`${fact.label} - ${fact.companyName}`, { size: 11, weight: bold });
    if (cursor.y < 64) fresh();
    for (const [x, label] of [
      [48, "Result"],
      [84, "Check"],
      [480, "Annex"],
    ]) {
      cursor.page.drawText(label, { x, y: cursor.y, size: 8, font: bold, color: muted });
    }
    cursor.y -= 13;
    for (const [result, text, annex] of fact.declarations) row(result, text, annex);
  }
  cursor.y -= 8;
  line("Disclosures", { size: 14, weight: bold });
  const disclosed = facts.filter((fact) => fact.disclosures.length);
  if (!disclosed.length) line("None.");
  for (const fact of disclosed) {
    cursor.y -= 4;
    line(`${fact.label} - ${fact.companyName}`, { size: 11, weight: bold });
    for (const text of fact.disclosures) line(`- ${text}`, { size: 10 });
  }
}

/** Companies House prints "Next … due by D … Last … D"; keep the last date, the due date and any overdue flag. */
function filingStatus(text, lastPattern, lastLabel) {
  const last = (text.match(lastPattern) || [])[1];
  const due = (text.match(/due by (\d{1,2} \w+ \d{4})/i) || [])[1];
  if (!last && !due) return text;
  return [last ? `${lastLabel} ${last}` : "", due ? `next due ${due}` : "", /overdue/i.test(text) ? "OVERDUE" : ""]
    .filter(Boolean)
    .join(" · ");
}

function shortControl(text) {
  return String(text || "")
    .split(";")
    .map((part) =>
      part
        .trim()
        .replace(/^Ownership of shares\s*[-–]\s*/i, "shares ")
        .replace(/^Ownership of voting rights\s*[-–]\s*/i, "votes ")
        .replace(/^Right to appoint or remove directors.*/i, "appoints directors")
        .replace(/^Has significant influence or control.*/i, "significant influence")
        .replace(/75% or more/i, "75%+")
        .replace(/More than 50% but less than 75%/i, "50-75%")
        .replace(/More than 25% but not more than 50%/i, "25-50%")
    )
    .filter(Boolean)
    .join(", ");
}

function parseDay(value) {
  const ms = Date.parse(String(value || "").trim());
  return Number.isNaN(ms) ? null : ms;
}

function withinMonths(value, months, today) {
  const ms = parseDay(value);
  return ms != null && ms <= today && today - ms <= months * 30.44 * 86400000;
}

function filingDate(label) {
  return (String(label || "").match(/[-—] (\d{1,2} \w{3,9} \d{4})$/) || [])[1] || "";
}

function displayName(name) {
  const [surname, rest] = String(name || "").split(",").map((part) => part.trim());
  if (!rest) return name;
  return `${rest} ${surname.charAt(0)}${surname.slice(1).toLowerCase()}`;
}

/** Declarations and disclosures come only from what this pack holds, so nothing is asserted that was not checked. */
function companyFacts(record, documents, letters, today) {
  const bundle = record.directoryId ? registryBundle(record.directoryId) : null;
  const profile = bundle?.profile || {};
  const officers = bundle?.officers || [];
  const pscs = bundle?.pscs || [];
  const sanctions = bundle?.sanctions;
  const mine = documents.filter((doc) => doc.partyId === record.directoryId);
  const matches = (keys) => mine.filter((doc) => keys.includes(doc.requirementKey) || keys.includes(doc.virtual));
  const has = (...keys) => keys.every((key) => matches([key]).length > 0);
  const annex = (...keys) =>
    matches(keys)
      .map((doc) => letters[doc.key])
      .join(", ");
  const yes = (value) => (value ? "Yes" : "No");
  const accountsOverdue = /overdue/i.test(profile.accounts || "");
  const statementOverdue = /overdue/i.test(profile.confirmationStatement || "");
  const declarations = [
    [yes(/^active$/i.test(profile.status || "")), "Active at Companies House", ""],
    [yes(!accountsOverdue), "Accounts up to date", ""],
    [yes(!statementOverdue), "Confirmation statement up to date", ""],
    [yes(sanctions && !sanctions.hitCount), "No UK Sanctions List match", annex("sanctions")],
  ];
  if (record.roleKey === "supplier") {
    declarations.push(
      [yes(has("vat")), "VAT certificate", annex("vat")],
      [
        yes(has("el_certificate", "pl_certificate", "pi_certificate")),
        "EL, PL and PI certificates",
        annex("el_certificate", "pl_certificate", "pi_certificate"),
      ],
      [yes(has("pi_schedule")), "PI policy schedule and wording", annex("pi_schedule")],
      [yes(has("bank")), "Bank statement for the account paying workers and HMRC", annex("bank")],
      [yes(has("payslip")), "Illustrative payslip", annex("payslip")],
      [yes(has("payroll_chain")), "Payroll chain map; PAYE references and ERNs confirmed", annex("payroll_chain")]
    );
  } else {
    declarations.push(
      [yes(has("paye_letter")), "HMRC PAYE registration letter", annex("paye_letter")],
      [
        yes(has("el_certificate", "el_schedule")),
        "EL certificate and policy pages naming the supplier",
        annex("el_certificate", "el_schedule"),
      ]
    );
  }
  declarations.push([
    yes(mine.length > 0 && mine.every((doc) => doc.receivedOn && doc.checkedOn)),
    "All documents received and checked",
    "",
  ]);

  const disclosures = [];
  if (profile.status && !/^active$/i.test(profile.status)) {
    disclosures.push(`Shown as ${profile.status} at Companies House.`);
  }
  if (accountsOverdue) disclosures.push("Accounts overdue.");
  if (statementOverdue) disclosures.push("Confirmation statement overdue.");
  if (withinMonths(profile.incorporatedOn, 12, today)) {
    disclosures.push(`Incorporated ${profile.incorporatedOn}, under a year ago.`);
  }
  for (const previous of profile.previousNames || []) {
    const changedOn = String(previous.period || "").split(/\s[-–]\s/)[1];
    if (withinMonths(changedOn, 24, today)) disclosures.push(`Name changed from ${previous.name} on ${changedOn}.`);
  }
  for (const doc of mine) {
    const date = filingDate(doc.label);
    if (doc.requirementKey === "registered_office" && withinMonths(date, 12, today)) {
      disclosures.push(`Registered office changed ${date}.`);
    }
  }
  for (const officer of officers) {
    const who = displayName(officer.name);
    const role = (officer.role || "officer").toLowerCase();
    if (withinMonths(officer.appointedOn, 12, today)) disclosures.push(`${who} appointed ${role} ${officer.appointedOn}.`);
    if (withinMonths(officer.resignedOn, 24, today)) disclosures.push(`${who} resigned as ${role} ${officer.resignedOn}.`);
  }
  for (const person of pscs) {
    if (withinMonths(person.ceasedOn, 24, today)) disclosures.push(`${person.name} ceased as a PSC ${person.ceasedOn}.`);
  }
  if (sanctions?.hitCount) {
    const names = (sanctions.hits || []).map((hit) => hit.name).join("; ");
    disclosures.push(
      `${sanctions.hitCount} possible UK Sanctions List match${sanctions.hitCount === 1 ? "" : "es"}: ${names}.`
    );
  }
  return { label: record.label, companyName: record.companyName, roleKey: record.roleKey, declarations, disclosures };
}

export const CERTIFICATE_SIGNATURE = { x: 48, y: 250, w: 260, h: 84 };

function addCertificate(doc, font, bold, { entity, broker, details, sources }) {
  const page = doc.addPage([595.28, 841.89]);
  const ink = rgb(0.1, 0.12, 0.16);
  const muted = rgb(0.38, 0.42, 0.48);
  const accent = rgb(0, 0.45, 1);
  let y = 790;
  const text = (value, { size = 11, weight = font, color = ink, after = 0, indent = 48, width = 88 } = {}) => {
    for (const part of wrap(value, width)) {
      page.drawText(pdfText(part), { x: indent, y, size, font: weight, color });
      y -= size + 6;
    }
    y -= after;
  };
  text("DUE DILIGENCE PACK", { size: 9, weight: bold, color: accent, after: 8 });
  text("Director's certificate", { size: 20, weight: bold, after: 6 });
  const legal = entity?.legal_name || entity?.display_name || "the broker";
  const client = details.client || "the client";
  text(`Given by ${legal} for the contract with ${client}. Pack reference ${details.reference}.`, {
    color: muted,
    after: 14,
  });
  const role = broker?.signer_role === "authorised_signatory" ? "Authorised signatory" : "Director";
  const signer = broker?.signer_name || "The broker's director";
  text(`I, ${signer}, ${role} of ${legal}, certify that:`, { after: 6 });

  const contractor = sources.records.find((record) => record.roleKey === "supplier");
  const supplier = sources.records.find((record) => record.roleKey === "spv");
  const companies = [contractor?.companyName, supplier?.companyName].filter(Boolean).join(" and ");
  const hmrc = [
    contractor ? `${contractor.companyName}'s payroll chain map and PAYE/ERN confirmation` : "",
    supplier ? `${supplier.companyName}'s HMRC PAYE registration letter` : "",
  ]
    .filter(Boolean)
    .join(" and ");
  const statements = [
    `I have reviewed the Companies House records, sanctions search and annexed documents for ${companies || "the companies in this pack"}.`,
    "Each document was received and checked on the dates in the annex index.",
    `HMRC standing is evidenced by ${hmrc || "the annexed documents"}.`,
    "The declarations and disclosures are complete and accurate. I know of nothing else the client should be told.",
  ];
  statements.forEach((statement, index) => {
    page.drawText(`${index + 1}.`, { x: 48, y, size: 11, font: bold, color: ink });
    text(statement, { indent: 68, width: 82, after: 6 });
  });

  const box = CERTIFICATE_SIGNATURE;
  page.drawText("Signature", { x: box.x, y: box.y + box.h + 8, size: 10, font: bold, color: muted });
  page.drawRectangle({
    x: box.x,
    y: box.y,
    width: box.w,
    height: box.h,
    borderColor: rgb(0.75, 0.78, 0.82),
    borderWidth: 1,
  });
  page.drawText(pdfText(`Name: ${signer}`), { x: box.x, y: box.y - 20, size: 11, font, color: ink });
  page.drawText(pdfText(`Role: ${role}, ${legal}`), { x: box.x, y: box.y - 36, size: 11, font, color: ink });
  page.drawText("Date:", { x: box.x, y: box.y - 52, size: 11, font, color: ink });
  return doc.getPageCount() - 1;
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
const INDEX_FIRST_PAGE_HEADER = 3;

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
      page.drawText("Annex index", { x: 48, y, size: 16, font: bold, color: ink });
      y -= 26;
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
  for (const row of sanctionLines(bundle?.sanctions)) {
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

import { PDFDocument, StandardFonts } from "pdf-lib";
import { db } from "./db.js";
import { readBytes } from "./storage.js";
import { embedLogoImage, resolveBrandPack } from "./bake.js";
import { coverDetails, ukDate } from "./coverStamp.js";
import { packSources, registryBundle } from "./partyRecords.js";
import {
  BODY_BOTTOM,
  BODY_TOP,
  CONTENT_W,
  MARGIN,
  PAGE,
  PackWriter,
  addBrandedCover,
  addPlainCover,
  drawFrame,
  packText,
  packTheme,
  placeInBody,
  wordmarkParts,
  wrapText,
} from "./packLayout.js";

export async function buildDueDiligencePdf(envelopeId) {
  const envelope = db.prepare("SELECT * FROM envelopes WHERE id = ?").get(envelopeId);
  const entity = db.prepare("SELECT * FROM entities WHERE id = ?").get(envelope.entity_id);
  const sources = packSources(envelopeId);
  const brand = resolveBrandPack(envelope.entity_id);
  const details = coverDetails(envelope, sources.byRole, entity, "Due diligence pack");
  const template = envelope.template_id
    ? db.prepare("SELECT name FROM templates WHERE id = ?").get(envelope.template_id)
    : null;
  const templateName = template?.name || "contract";
  const brokerName = entity?.display_name || "the broker";
  const prepared = ukDate(localDay());

  const out = await PDFDocument.create();
  const font = await out.embedFont(StandardFonts.Helvetica);
  const bold = await out.embedFont(StandardFonts.HelveticaBold);
  const theme = packTheme(entity);
  const fonts = { font, bold, theme };
  let logo = null;
  if (brand.logo) {
    try {
      logo = await embedLogoImage(out, brand.logo);
    } catch {
      logo = null;
    }
  }

  const cover = {
    title: "DUE DILIGENCE",
    subtitle: "CONTRACTOR ONBOARDING PACK",
    brand: brokerName.toUpperCase(),
    packTitle: "Due Diligence & Onboarding Pack",
    forUse: `For use with the ${brokerName} ${templateName}`,
    parties: [
      ["Contractor", details.contractor || "—"],
      ...(details.supplier ? [["Supplier", details.supplier]] : []),
      ["Client", details.client || "—"],
      ["Pack reference", details.reference],
    ],
    legal: [
      brokerName,
      ...(entity?.legal_name && entity.legal_name !== brokerName ? [entity.legal_name] : []),
      ...(entity?.company_number ? [`Company number ${entity.company_number}`] : []),
      ...(entity?.registered_office ? [`Registered office: ${entity.registered_office}`] : []),
    ],
    meta: [
      ["Prepared", prepared],
      ["Doc ID", details.reference],
    ],
  };
  if (!(await addBrandedCover(out, brand.front, fonts, cover))) addPlainCover(out, fonts, cover, logo);

  const letters = Object.fromEntries(sources.documents.map((doc, index) => [doc.key, annexLetter(index)]));
  const writer = new PackWriter(out, fonts);
  const today = Date.now();
  const facts = sources.records.map((record) => companyFacts(record, sources.documents, letters, today));
  let part = 0;
  const nextPart = () => String.fromCharCode(65 + part++);

  writer.newPage();
  writePackDetails(writer, nextPart(), { details, entity, brokerName, templateName, prepared, sources });
  sources.records.forEach((record, index) => {
    writeCompany(writer, nextPart(), record, facts[index], letters);
  });
  writeDisclosures(writer, nextPart(), facts);
  addCertificate(writer, nextPart(), { entity, broker: sources.byRole.agency, details, sources });
  const certPage = out.getPageCount() - 1;

  const attachments = [];
  for (const doc of sources.documents) {
    if (doc.virtual) {
      attachments.push({ doc, pages: 1, virtual: true });
      continue;
    }
    const bytes = readBytes(doc.storageRef);
    if (bytes.slice(0, 5).toString() === "%PDF-") {
      const src = await PDFDocument.load(bytes);
      // A Companies House filing's first page is the certificate or notice; the rest is the application and articles.
      const indices = doc.source === "companies_house" ? [0] : src.getPageIndices();
      attachments.push({ doc, src, indices, pages: indices.length });
    } else {
      attachments.push({ doc, bytes, pages: 1, image: true });
    }
  }

  const scratch = await PDFDocument.create();
  const scratchWriter = new PackWriter(scratch, {
    font: await scratch.embedFont(StandardFonts.Helvetica),
    bold: await scratch.embedFont(StandardFonts.HelveticaBold),
    theme,
  });
  writeIndex(scratchWriter, placeAttachments(0, attachments));
  const placed = placeAttachments(out.getPageCount() + scratch.getPageCount() + 1, attachments);
  writeIndex(writer, placed);

  for (const [index, item] of placed.entries()) {
    await addAnnexPages(out, writer, item, annexLetter(index), fonts);
  }

  const footer = `DUE DILIGENCE PACK ${details.reference.split("-")[1] || ""} · ${templateName} · Doc ID: ${details.reference}`;
  const wordmark = wordmarkParts(brokerName);
  const evidencePages = new Set(
    placed.filter((item) => !item.virtual).flatMap((item) => Array.from({ length: item.pages }, (_, i) => item.start + i)),
  );
  for (let index = 1; index < out.getPageCount(); index += 1) {
    const pageNumber = index + 1;
    drawFrame(out.getPage(index), {
      pageNumber,
      theme,
      font,
      bold,
      logo,
      wordmark,
      footer,
      watermark: !evidencePages.has(pageNumber),
    });
  }
  const backPages = await addBackCover(out, brand.back);
  return { bytes: Buffer.from(await out.save()), backPages, certPage };
}

function localDay() {
  const day = new Date();
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
}

function placeAttachments(firstPage, attachments) {
  let page = firstPage;
  return attachments.map((item) => {
    const start = page;
    page += item.pages;
    return { ...item, start };
  });
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
  const page = out.addPage([PAGE.w, PAGE.h]);
  const image = bytes[0] === 0xff ? await out.embedJpg(bytes) : await out.embedPng(bytes);
  page.drawImage(image, { x: 0, y: 0, width: PAGE.w, height: PAGE.h });
  return 1;
}

const KV = [
  { label: "", width: 150 },
  { label: "", width: CONTENT_W - 150 },
];

function writePackDetails(writer, letter, { details, entity, brokerName, templateName, prepared, sources }) {
  writer.part(`Part ${letter} — Pack details`);
  const numbered = (name, number) => (number ? `${name} · company number ${number}` : name || "—");
  const broker = [brokerName, entity?.legal_name && entity.legal_name !== brokerName ? entity.legal_name : ""]
    .filter(Boolean)
    .join(" — ");
  const contractor = sources.records.find((record) => record.roleKey === "supplier");
  const supplier = sources.records.find((record) => record.roleKey === "spv");
  writer.table(
    KV,
    [
      ["Broker", numbered(broker, entity?.company_number)],
      ["Contractor", numbered(details.contractor, contractor?.companyNumber)],
      ...(details.supplier ? [["Supplier (SPV)", numbered(details.supplier, supplier?.companyNumber)]] : []),
      ["Client", numbered(details.client, sources.byRole.company?.company_number)],
      ["Contract", `${templateName} · ${details.version}`],
      ["Pack reference", details.reference],
      ["Prepared", prepared],
      ["Next review due", "12 months from the date signed"],
    ],
    { header: false, labelColumn: true }
  );
}

function writeCompany(writer, letter, record, fact, letters) {
  const bundle = record.directoryId ? registryBundle(record.directoryId) : null;
  const profile = bundle?.profile || {};
  const sanctions = bundle?.sanctions;
  writer.part(`Part ${letter} — ${record.label}: ${record.companyName}`);

  writer.sub(`${letter}1  Company details`);
  const sanctionsAnnex = letters[`sanctions:${record.directoryId}`];
  const sanctionsText = sanctions
    ? `${sanctions.hitCount ? `${sanctions.hitCount} possible match${sanctions.hitCount === 1 ? "" : "es"}` : "No match"} · list dated ${sanctions.listedOn || "—"}${sanctionsAnnex ? ` · Annex ${sanctionsAnnex}` : ""}`
    : "Not run";
  writer.table(
    KV,
    [
      ["Legal name", profile.legalName || record.companyName],
      ["Company number", profile.companyNumber || record.companyNumber || "—"],
      ["Incorporated", chDate(profile.incorporatedOn) || "—"],
      ...(profile.previousNames || []).map((previous) => ["Former name", `${previous.name}${previous.period ? ` (${chPeriod(previous.period)})` : ""}`]),
      ["Registered office", profile.registeredOffice || "—"],
      ["Company status", profile.status || "—"],
      ["Accounts", profile.accounts ? filingStatus(profile.accounts, /Last accounts made up to (\d{1,2} \w+ \d{4})/i, "Made up to") : "—"],
      [
        "Confirmation statement",
        profile.confirmationStatement
          ? filingStatus(profile.confirmationStatement, /Last statement dated (\d{1,2} \w+ \d{4})/i, "Dated")
          : "—",
      ],
      ["UK Sanctions List", sanctions?.hitCount ? { text: sanctionsText, color: writer.theme.alert } : sanctionsText],
    ],
    { header: false, labelColumn: true }
  );

  writer.sub(`${letter}2  Directors`);
  const officers = (bundle?.officers || []).filter((officer) => !officer.resignedOn);
  writer.table(
    [
      { label: "Name", width: 190 },
      { label: "Role", width: 95 },
      { label: "Appointed", width: 75 },
      { label: "Country of residence", width: CONTENT_W - 360 },
    ],
    officers.length
      ? officers.map((officer) => [displayName(officer.name), officer.role || "—", chDate(officer.appointedOn) || "—", officer.country || "—"])
      : [["None returned", "", "", ""]]
  );

  const pscs = bundle?.pscs || [];
  writer.sub(`${letter}3  People with significant control`);
  writer.table(
    [
      { label: "Name", width: 150 },
      { label: "Notified", width: 65 },
      { label: "Ceased", width: 65 },
      { label: "Nature of control", width: CONTENT_W - 280 },
    ],
    pscs.length
      ? pscs.map((person) => [person.name, chDate(person.notifiedOn) || "—", chDate(person.ceasedOn) || "—", shortControl(person.natureOfControl) || "—"])
      : [["None returned", "", "", ""]]
  );

  writer.sub(`${letter}4  Checks`);
  writer.table(
    [
      { label: "Check", width: CONTENT_W - 150 },
      { label: "Result", width: 90 },
      { label: "Annex", width: 60 },
    ],
    fact.declarations.map(([result, text, annex]) => [text, { yesNo: result === "Yes" }, annex || "—"])
  );
}

function writeDisclosures(writer, letter, facts) {
  writer.part(`Part ${letter} — Disclosures`);
  const rows = facts.flatMap((fact) => fact.disclosures.map((text) => [fact.companyName, text]));
  writer.table(
    [
      { label: "Company", width: 150 },
      { label: "Disclosure", width: CONTENT_W - 150 },
    ],
    rows.length ? rows : [["—", "None"]]
  );
}

/** Companies House prints "Next … due by D … Last … D"; keep the last date, the due date and any overdue flag. */
function filingStatus(text, lastPattern, lastLabel) {
  const last = (text.match(lastPattern) || [])[1];
  const due = (text.match(/due by (\d{1,2} \w+ \d{4})/i) || [])[1];
  if (!last && !due) return text;
  return [last ? `${lastLabel} ${chDate(last)}` : "", due ? `next due ${chDate(due)}` : "", /overdue/i.test(text) ? "OVERDUE" : ""]
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
        .replace(/More than 50% but less than 75%/i, "50–75%")
        .replace(/More than 25% but not more than 50%/i, "25–50%")
    )
    .filter(Boolean)
    .join(", ");
}

function parseDay(value) {
  const ms = Date.parse(String(value || "").trim());
  return Number.isNaN(ms) ? null : ms;
}

/** Companies House dates ("24 October 2022", "24 Oct 2022") as dd/mm/yyyy. */
function chDate(value) {
  const ms = parseDay(value);
  if (ms == null) return String(value || "");
  const day = new Date(ms);
  return `${String(day.getDate()).padStart(2, "0")}/${String(day.getMonth() + 1).padStart(2, "0")}/${day.getFullYear()}`;
}

function chPeriod(period) {
  return String(period)
    .split(/\s[-–]\s/)
    .map(chDate)
    .join(" – ");
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
    disclosures.push(`Incorporated ${chDate(profile.incorporatedOn)}, under a year ago.`);
  }
  for (const previous of profile.previousNames || []) {
    const changedOn = String(previous.period || "").split(/\s[-–]\s/)[1];
    if (withinMonths(changedOn, 24, today)) disclosures.push(`Name changed from ${previous.name} on ${chDate(changedOn)}.`);
  }
  for (const doc of mine) {
    const date = filingDate(doc.label);
    if (doc.requirementKey === "registered_office" && withinMonths(date, 12, today)) {
      disclosures.push(`Registered office changed ${chDate(date)}.`);
    }
  }
  for (const officer of officers) {
    const who = displayName(officer.name);
    const role = (officer.role || "officer").toLowerCase();
    if (withinMonths(officer.appointedOn, 12, today)) disclosures.push(`${who} appointed ${role} ${chDate(officer.appointedOn)}.`);
    if (withinMonths(officer.resignedOn, 24, today)) disclosures.push(`${who} resigned as ${role} ${chDate(officer.resignedOn)}.`);
  }
  for (const person of pscs) {
    if (withinMonths(person.ceasedOn, 24, today)) disclosures.push(`${person.name} ceased as a PSC ${chDate(person.ceasedOn)}.`);
  }
  if (sanctions?.hitCount) {
    const names = (sanctions.hits || []).map((hit) => hit.name).join("; ");
    disclosures.push(
      `${sanctions.hitCount} possible UK Sanctions List match${sanctions.hitCount === 1 ? "" : "es"}: ${names}.`
    );
  }
  return { label: record.label, companyName: record.companyName, roleKey: record.roleKey, declarations, disclosures };
}

const CERT_TOP = 500;
const CERT_LABEL_W = 150;
const CERT_ROW = 22;
const CERT_SIGNATURE_ROW = 52;

/** Where signing stamps the signature, the date and the evidence lines on the certificate page. */
export const CERTIFICATE_SIGNATURE = {
  x: MARGIN + CERT_LABEL_W + 4,
  y: CERT_TOP - CERT_ROW * 3 - CERT_SIGNATURE_ROW + 5,
  w: CONTENT_W - CERT_LABEL_W - 8,
  h: CERT_SIGNATURE_ROW - 10,
  dateX: MARGIN + CERT_LABEL_W + 6,
  dateY: CERT_TOP - CERT_ROW * 4 - CERT_SIGNATURE_ROW + 7.5,
  evidenceX: MARGIN,
  evidenceY: CERT_TOP - CERT_ROW * 4 - CERT_SIGNATURE_ROW - 14,
};

function addCertificate(writer, letter, { entity, broker, details, sources }) {
  const { font, bold, theme } = writer;
  writer.newPage();
  writer.part(`Part ${letter} — Director's certificate`);
  const legal = entity?.legal_name || entity?.display_name || "the broker";
  const role = broker?.signer_role === "authorised_signatory" ? "Authorised signatory" : "Director";
  const signer = broker?.signer_name || "The broker's director";
  writer.text(`Given by ${legal} for the contract with ${details.client || "the client"}. Pack reference ${details.reference}.`, {
    color: theme.muted,
    after: 8,
  });
  writer.text(`I, ${signer}, ${role} of ${legal}, certify that:`, { size: 9.5, after: 6 });

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
    wrapText(statement, font, 9.5, CONTENT_W - 20).forEach((line, n) => {
      if (n === 0) writer.draw(`${index + 1}.`, MARGIN, writer.y - 9.5, { size: 9.5, font: bold });
      writer.draw(line, MARGIN + 20, writer.y - 9.5, { size: 9.5 });
      writer.y -= 13.5;
    });
    writer.y -= 5;
  });

  const page = writer.page;
  const rows = [
    ["Name — broker director", signer, CERT_ROW],
    ["Position", role, CERT_ROW],
    ["Company", legal, CERT_ROW],
    ["Signature", "", CERT_SIGNATURE_ROW],
    ["Date signed", "", CERT_ROW],
  ];
  let top = CERT_TOP;
  for (const [label, value, height] of rows) {
    page.drawRectangle({ x: MARGIN, y: top - height, width: CERT_LABEL_W, height, borderColor: theme.rule, borderWidth: 0.6 });
    page.drawRectangle({
      x: MARGIN + CERT_LABEL_W,
      y: top - height,
      width: CONTENT_W - CERT_LABEL_W,
      height,
      borderColor: theme.rule,
      borderWidth: 0.6,
    });
    page.drawText(packText(label), { x: MARGIN + 5, y: top - 14, size: 8.5, font: bold, color: theme.ink });
    if (value) {
      const line = wrapText(value, font, 8.5, CONTENT_W - CERT_LABEL_W - 10)[0];
      page.drawText(line, { x: MARGIN + CERT_LABEL_W + 6, y: top - 14, size: 8.5, font, color: theme.ink });
    }
    top -= height;
  }
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

function writeIndex(writer, placed) {
  writer.newPage();
  writer.part("Annex index");
  writer.table(
    [
      { label: "Annex", width: 36 },
      { label: "Document", width: 196 },
      { label: "Company", width: 107 },
      { label: "Pages", width: 40 },
      { label: "Received", width: 52 },
      { label: "Checked", width: CONTENT_W - 431 },
    ],
    placed.map((item, index) => {
      const end = item.start + item.pages - 1;
      return [
        { text: annexLetter(index), bold: true },
        item.doc.label,
        item.doc.companyName,
        end > item.start ? `${item.start}–${end}` : String(item.start),
        ukDate(item.doc.receivedOn) || "—",
        ukDate(item.doc.checkedOn) || "—",
      ];
    }),
    { size: 8 }
  );
}

function annexCaption(page, { font, bold, theme }, letter, doc, continued = false) {
  const caption = `${letter}. ${String(doc.label).replace(" — ", ", ")} — ${doc.companyName}`;
  if (continued) {
    const line = wrapText(`${caption} (continued)`, font, 8, CONTENT_W)[0];
    page.drawText(line, { x: MARGIN, y: BODY_TOP - 9, size: 8, font, color: theme.muted });
    return;
  }
  const line = wrapText(caption, bold, 9.5, CONTENT_W)[0];
  page.drawText(line, { x: MARGIN, y: BODY_TOP - 10, size: 9.5, font: bold, color: theme.ink });
}

async function addAnnexPages(out, writer, item, letter, fonts) {
  const { theme } = fonts;
  const bottom = BODY_BOTTOM + 4;
  if (item.virtual) {
    const page = writer.newPage();
    annexCaption(page, fonts, letter, item.doc);
    writer.y = BODY_TOP - 26;
    writeSanctions(writer, registryBundle(item.doc.partyId)?.sanctions);
    return;
  }
  if (item.image) {
    const page = out.addPage([PAGE.w, PAGE.h]);
    annexCaption(page, fonts, letter, item.doc);
    const image = item.bytes[0] === 0xff ? await out.embedJpg(item.bytes) : await out.embedPng(item.bytes);
    placeInBody(page, image, { top: BODY_TOP - 22, bottom, rule: theme.rule });
    return;
  }
  let embedded;
  try {
    embedded = await out.embedPdf(item.src, item.indices);
  } catch {
    const copies = await out.copyPages(item.src, item.indices);
    copies.forEach((page) => out.addPage(page));
    return;
  }
  embedded.forEach((source, n) => {
    const page = out.addPage([PAGE.w, PAGE.h]);
    annexCaption(page, fonts, letter, item.doc, n > 0);
    placeInBody(page, source, {
      top: n === 0 ? BODY_TOP - 22 : BODY_TOP - 18,
      bottom,
      rotation: item.src.getPage(item.indices[n]).getRotation().angle,
      rule: theme.rule,
    });
  });
}

function writeSanctions(writer, sanctions) {
  if (!sanctions) {
    writer.text("The sanctions search has not been run.");
    return;
  }
  const query = sanctions.query || {};
  const rows = [
    ["List", `UK Sanctions List published ${sanctions.listedOn || "—"}`],
    ["Source", sanctions.listUrl || "https://sanctionslist.fcdo.gov.uk/"],
    ["Searched", ukDate(sanctions.searchedAt) || "—"],
    ["Company", query.companyName || "—"],
    ["Company number", query.companyNumber || "—"],
    ...((query.previousNames || []).length ? [["Previous names", query.previousNames.join("; ")]] : []),
    ["Directors and PSCs", (query.people || []).join("; ") || "—"],
    [
      "Result",
      sanctions.hitCount
        ? { text: `${sanctions.hitCount} possible match${sanctions.hitCount === 1 ? "" : "es"}`, color: writer.theme.alert, bold: true }
        : { text: "No match", bold: true },
    ],
  ];
  writer.table(KV, rows, { header: false, labelColumn: true });
  if (sanctions.hits?.length) {
    writer.table(
      [
        { label: "Listed name", width: 180 },
        { label: "Regime", width: 160 },
        { label: "Matched on", width: CONTENT_W - 340 },
      ],
      sanctions.hits.slice(0, 20).map((hit) => [hit.name, hit.regime || "—", (hit.matchedOn || []).join(", ")])
    );
  }
}

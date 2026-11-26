import { PDFDocument, StandardFonts } from "pdf-lib";
import { db } from "./db.js";
import { readBytes } from "./storage.js";
import { embedLogoImage, resolveBrandPack } from "./bake.js";
import { coverDetails, ukDate } from "./coverStamp.js";
import { packSources, registryBundle } from "./partyRecords.js";
import {
  REVIEW_FREQUENCIES,
  chainNames,
  insuranceChecks,
  localDay,
  nextReview,
  pepRows,
  reviewFrequency,
  rolesText,
  workerArrangements,
} from "./ddChecks.js";
import {
  BODY_BOTTOM,
  BODY_TOP,
  CONTENT_W,
  MARGIN,
  PAGE,
  PackWriter,
  addBrandedBackCover,
  addBrandedCover,
  addPlainCover,
  brokerLegalName,
  drawFrame,
  normalCase,
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
  const contractName = `${details.version === "4-way" ? "Four-party" : "Three-party"} ${templateName}`;
  const brokerName = entity?.display_name || "the broker";
  const brokerLegal = brokerLegalName(entity) || brokerName;
  const packDay = localDay();
  const prepared = ukDate(packDay);
  const names = chainNames(envelope, sources, entity);
  const pep = pepRows(envelopeId, sources.records);

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

  const [legalBase, trading] = splitTrading(brokerLegal);
  const cover = {
    title: "DUE DILIGENCE PACK",
    subtitle: "",
    brand: brokerName.toUpperCase(),
    packTitle: "Due Diligence Pack",
    forUse: `For use with the ${brokerName} ${contractName}`,
    parties: [
      ["Contractor", details.contractor || "—"],
      ...(details.supplier ? [["Supplier (SPV)", details.supplier]] : []),
      ["Client", details.client || "—"],
      ["Pack reference", details.reference],
    ],
    legal: [
      legalBase,
      ...(trading ? [trading] : []),
      ...(entity?.company_number ? [`Company number ${entity.company_number}`] : []),
      ...(entity?.registered_office ? [`Registered office: ${entity.registered_office}`] : []),
    ],
    meta: [["Prepared", prepared]],
  };
  if (!(await addBrandedCover(out, brand.front, fonts, cover))) addPlainCover(out, fonts, cover, logo);

  const annexNo = Object.fromEntries(sources.documents.map((doc, index) => [doc.key, String(index + 1)]));
  const titles = Object.fromEntries(sources.documents.map((doc) => [doc.key, documentTitle(doc)]));
  const writer = new PackWriter(out, fonts);
  const facts = sources.records.map((record) => companyFacts(record, sources.documents, annexNo, { pep, packDay }));
  let part = 0;
  const nextPart = () => String.fromCharCode(65 + part++);

  writer.newPage();
  writePackDetails(writer, nextPart(), { details, entity, brokerLegal, contractName, prepared, sources, envelope, names, packDay });
  writeSupplyChain(writer, nextPart(), names);
  const partFor = {};
  sources.records.forEach((record, index) => {
    partFor[record.roleKey] = nextPart();
    writeCompany(writer, partFor[record.roleKey], record, facts[index], annexNo);
  });
  writeDisclosures(writer, nextPart(), facts);
  writeWorkerArrangements(writer, nextPart(), workerArrangements(envelope, names));
  const certTop = addCertificate(writer, nextPart(), { entity, brokerLegal, broker: sources.byRole.agency, details, sources, annexNo });
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
  const sections = sources.records
    .map((record) => ({
      record,
      letter: partFor[record.roleKey],
      items: attachments.filter((item) => item.doc.roleKey === record.roleKey),
    }))
    .filter((section) => section.items.length);
  writeIndex(scratchWriter, placeSections(0, sections), annexNo, titles);
  const placed = placeSections(out.getPageCount() + scratch.getPageCount() + 1, sections);
  writeIndex(writer, placed, annexNo, titles);

  for (const section of placed) {
    addSectionDivider(writer, section, annexNo);
    for (const item of section.items) {
      await addAnnexPages(out, writer, item, annexCaption(annexNo[item.doc.key], titles[item.doc.key]), fonts);
    }
  }

  const footer = `Due Diligence Pack ${details.reference.split("-")[1] || ""}, Pack reference ${details.reference}`;
  const wordmark = wordmarkParts(brokerName);
  const evidencePages = new Set(
    placed
      .flatMap((section) => section.items)
      .filter((item) => !item.virtual)
      .flatMap((item) => Array.from({ length: item.pages }, (_, i) => item.start + i)),
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
  const backPages = await addBrandedBackCover(out, brand.back, fonts, {
    name: brokerLegal,
    companyNumber: entity?.company_number || "",
    registeredOffice: entity?.registered_office || "",
  });
  return { bytes: Buffer.from(await out.save()), backPages, certPage, certTop };
}

/** "UNION WORK SERVICES LIMITED (trading as Union Payroll)" as its name and its trading line. */
function splitTrading(name) {
  const match = String(name).match(/^(.*?)\s*(\(trading as [^)]*\))\s*$/i);
  return match ? [match[1], match[2]] : [String(name), ""];
}

/** Page numbers for each company's divider page and the annex pages after it. */
function placeSections(firstPage, sections) {
  let page = firstPage;
  return sections.map((section) => {
    const divider = page;
    page += 1;
    const items = section.items.map((item) => {
      const start = page;
      page += item.pages;
      return { ...item, start };
    });
    return { ...section, divider, items };
  });
}

const sectionTitle = (section) => `Part ${section.letter} — ${section.record.label}: ${section.record.companyName}`;

function pageRange(item) {
  const end = item.start + item.pages - 1;
  return end > item.start ? `${item.start}–${end}` : String(item.start);
}

/** "6, 7, 8, 10" as "6–8, 10". */
function annexList(numbers) {
  const sorted = [...new Set(numbers.filter(Boolean).map(Number))].sort((a, b) => a - b);
  const runs = [];
  for (const n of sorted) {
    const last = runs.at(-1);
    if (last && n === last[1] + 1) last[1] = n;
    else runs.push([n, n]);
  }
  return runs.map(([from, to]) => (to > from ? `${from}–${to}` : String(from))).join(", ");
}

/** The document's name and date as one title: "Certificate of incorporation, 24/10/2022". */
function documentTitle(doc) {
  if (doc.virtual === "sanctions") {
    const searched = registryBundle(doc.partyId)?.sanctions?.searchedAt;
    return `UK Sanctions List screening${searched ? `, ${ukDate(searched)}` : ""}`;
  }
  const date = filingDate(doc.label);
  const name = String(doc.label).replace(/\s+[-—]\s+\d{1,2} \w{3,9} \d{4}$/, "");
  return date ? `${name}, ${chDate(date)}` : name;
}

const annexCaption = (number, title) => `Annex ${number}: ${title}`;

const KV = [
  { label: "", width: 150 },
  { label: "", width: CONTENT_W - 150 },
];

function writePackDetails(writer, letter, { details, entity, brokerLegal, contractName, prepared, sources, envelope, names, packDay }) {
  writer.part(`Part ${letter} — Pack details`);
  const numbered = (name, number) => (number ? `${name || "—"}, company\u00a0number\u00a0${number}` : name || "—");
  const contractor = sources.records.find((record) => record.roleKey === "supplier");
  const supplier = sources.records.find((record) => record.roleKey === "spv");
  writer.table(
    KV,
    [
      ["Broker", numbered(brokerLegal, entity?.company_number)],
      ["Contractor", numbered(details.contractor, contractor?.companyNumber)],
      ...(details.supplier ? [["Supplier (SPV)", numbered(details.supplier, supplier?.companyNumber)]] : []),
      ["Client", numbered(details.client, sources.byRole.company?.company_number)],
      ["Contract", contractName],
      ["Pack reference", details.reference],
      ["Prepared", prepared],
      ["Review frequency", REVIEW_FREQUENCIES[reviewFrequency(envelope)].label],
      ["Next review", ukDate(nextReview(envelope, packDay))],
    ],
    { header: false, labelColumn: true }
  );
  const frequency = REVIEW_FREQUENCIES[reviewFrequency(envelope)].label.toLowerCase();
  writer.text(
    `${names.broker} carries out ${frequency} checks of HMRC payments, Companies House records, sanctions screening and insurance for every company in this supply chain.`
  );
  writer.text(
    names.four
      ? `${names.contractor} and ${names.supplier} must tell ${names.broker} within 5 working days of any change to their directors, owners, insurance or HMRC position.`
      : `${names.contractor} must tell ${names.broker} within 5 working days of any change to its directors, owners, insurance or HMRC position.`
  );
}

function writeSupplyChain(writer, letter, names) {
  writer.part(`Part ${letter} — Supply chain`);
  drawChain(writer, [
    { name: names.client, role: "agency" },
    { name: names.broker, role: "broker" },
    { name: names.contractor, role: names.four ? "payroll company" : "payroll company and employer" },
    ...(names.four ? [{ name: names.supplier, role: "employer" }] : []),
    { name: "Workers", role: "" },
  ]);
  writer.table(
    KV,
    [
      ["Employer of the workers", names.employer],
      ["Runs PAYE", names.employer],
      ["PAYE reference", names.employerRecord?.payeReference || "—"],
      ["Liable party for unpaid PAYE", `${names.client} (agency)`],
    ],
    { header: false, labelColumn: true }
  );
  writer.text(
    `Under the umbrella company PAYE rules in force from 6 April 2026, if ${names.employer} fails to pay PAYE due on workers’ pay, HMRC can recover it from ${names.client} as the agency in this supply chain.`
  );
}

/** The chain as boxes joined by arrows, left to right. */
function drawChain(writer, nodes) {
  const { font, bold, theme } = writer;
  const gap = 18;
  const boxW = (CONTENT_W - gap * (nodes.length - 1)) / nodes.length;
  const laid = nodes.map((node) => ({
    name: wrapText(node.name, bold, 8.5, boxW - 10),
    role: node.role ? wrapText(node.role, font, 7.5, boxW - 10) : [],
  }));
  const contentH = (item) => item.name.length * 11 + item.role.length * 9.5 - 3;
  const boxH = Math.max(...laid.map(contentH)) + 18;
  writer.ensure(boxH + 22);
  const page = writer.page;
  const top = writer.y - 2;
  laid.forEach((item, index) => {
    const x = MARGIN + index * (boxW + gap);
    page.drawRectangle({ x, y: top - boxH, width: boxW, height: boxH, color: theme.tint, borderColor: theme.accent, borderWidth: 0.8 });
    let y = top - (boxH - contentH(item)) / 2 - 7;
    for (const line of item.name) {
      page.drawText(line, { x: x + (boxW - bold.widthOfTextAtSize(line, 8.5)) / 2, y, size: 8.5, font: bold, color: theme.ink });
      y -= 11;
    }
    for (const line of item.role) {
      page.drawText(line, { x: x + (boxW - font.widthOfTextAtSize(line, 7.5)) / 2, y: y + 1, size: 7.5, font, color: theme.muted });
      y -= 9.5;
    }
    if (index < laid.length - 1) {
      const mid = top - boxH / 2;
      const from = x + boxW + 3;
      const to = x + boxW + gap - 3;
      const arrow = (x1, y1) =>
        page.drawLine({ start: { x: x1, y: y1 }, end: { x: to, y: mid }, thickness: 1.2, color: theme.accent });
      arrow(from, mid);
      arrow(to - 4, mid + 3);
      arrow(to - 4, mid - 3);
    }
  });
  writer.y = top - boxH - 14;
}

/** The sanctions list is published as "24-Nov-2026". */
function listDate(value) {
  const text = String(value || "");
  return /^\d{1,2}-[A-Za-z]{3}-\d{4}$/.test(text) ? chDate(text.replace(/-/g, " ")) : chDate(text);
}

function writeCompany(writer, letter, record, fact, annexNo) {
  const bundle = record.directoryId ? registryBundle(record.directoryId) : null;
  const profile = bundle?.profile || {};
  const sanctions = bundle?.sanctions;
  writer.part(`Part ${letter} — ${record.label}: ${record.companyName}`);

  writer.sub(`${letter}1  Company details`);
  const sanctionsAnnex = annexNo[`sanctions:${record.directoryId}`];
  const sanctionsDetail = `, list dated ${listDate(sanctions?.listedOn) || "—"}${sanctionsAnnex ? `, Annex ${sanctionsAnnex}` : ""}`;
  const sanctionsCell = !sanctions
    ? "Not run"
    : sanctions.hitCount
      ? {
          runs: [
            { text: `Flag, ${sanctions.hitCount} possible match${sanctions.hitCount === 1 ? "" : "es"}`, bold: true, color: writer.theme.alert },
            { text: sanctionsDetail },
          ],
        }
      : { runs: [{ text: "Clear", bold: true, color: writer.theme.ok }, { text: sanctionsDetail }] };
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
      ["UK Sanctions List", sanctionsCell],
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

  const checkColumns = [
    { label: "Check", width: CONTENT_W - 140 },
    { label: "Result", width: 80, align: "center" },
    { label: "Annex", width: 60, align: "center" },
  ];
  const checkRows = fact.declarations.map(([result, text, annex]) => [
    text,
    typeof result === "object" ? result : { result },
    annex || "—",
  ]);
  writer.ensure(24 + writer.tableHeight(checkColumns, checkRows) + 20);
  writer.sub(`${letter}4  Checks`);
  writer.table(checkColumns, checkRows);
  writer.y += 4;
  writer.labelLine([
    ["Reviewed by", fact.reviewer || "—"],
    ["Date", fact.reviewedOn ? ukDate(fact.reviewedOn) : "—"],
  ]);
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

function writeWorkerArrangements(writer, letter, rows) {
  writer.part(`Part ${letter} — Worker arrangements`);
  writer.table(
    [
      { label: "Topic", width: 120 },
      { label: "Arrangement", width: CONTENT_W - 200 },
      { label: "Confirmed", width: 80, align: "center" },
    ],
    rows.map((row) => [row.label, row.text, row.confirmed ? { result: "clear", label: "Yes" } : { result: "na", label: "Pending" }]),
    { labelColumn: true }
  );
}

/** Companies House prints "Next … due by D … Last … D"; keep the last date, the due date and any overdue flag. */
function filingStatus(text, lastPattern, lastLabel) {
  const last = (text.match(lastPattern) || [])[1];
  const due = (text.match(/due by (\d{1,2} \w+ \d{4})/i) || [])[1];
  if (!last && !due) return text;
  return [last ? `${lastLabel} ${chDate(last)}` : "", due ? `next due ${chDate(due)}` : "", /overdue/i.test(text) ? "OVERDUE" : ""]
    .filter(Boolean)
    .join(", ");
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

function filingDate(label) {
  return (String(label || "").match(/[-—] (\d{1,2} \w{3,9} \d{4})$/) || [])[1] || "";
}

function displayName(name) {
  const [surname, rest] = String(name || "").split(",").map((part) => part.trim());
  if (!rest) return name;
  return `${rest} ${surname.charAt(0)}${surname.slice(1).toLowerCase()}`;
}

const CH_DAY = /\d{1,2} [A-Za-z]{3,9} \d{4}/;
const withoutTitle = (name) => String(name || "").replace(/^(mr|mrs|ms|miss|mx|dr|sir|prof)\.?\s+/i, "").trim();

/** One line per Companies House change, from the filing history descriptions. */
function changeLine({ type, description }) {
  const on = (description.match(new RegExp(`on (${CH_DAY.source})\\s*$`)) || [])[1] || "";
  const day = chDate(on);
  if (type === "AD01") {
    const moved = description.match(new RegExp(`changed from (.+?) to (.+) on ${CH_DAY.source}\\s*$`, "i"));
    if (moved) return `Registered office changed from ${moved[1]} to ${moved[2]} on ${day}`;
  }
  const appointed = description.match(/^Appointment of (.+?) as an? (director|secretary)/i);
  if (appointed) return `${withoutTitle(appointed[1])} appointed as a ${appointed[2].toLowerCase()} on ${day}`;
  const ended = description.match(/^Termination of appointment of (.+?) as an? (director|secretary)/i);
  if (ended) return `${withoutTitle(ended[1])} resigned as a ${ended[2].toLowerCase()} on ${day}`;
  const notified = description.match(/^(?:Notification|Change of details) of (.+?) as a person with significant control/i);
  if (notified && /^PSC0[1-3]$/.test(type)) return `${withoutTitle(notified[1])} became a person with significant control on ${day}`;
  const ceased = description.match(/^Cessation of (.+?) as a person with significant control/i);
  if (ceased) return `${withoutTitle(ceased[1])} ceased to be a person with significant control on ${day}`;
  return description.replace(new RegExp(CH_DAY.source, "g"), (match) => chDate(match)).replace(/\.\s*$/, "");
}

/** Every recorded change of name, office, director and PSC, oldest first. */
function companyChanges(profile, officers, pscs, mine) {
  const events = [];
  const names = [...(profile.previousNames || [])]
    .map((previous) => ({ ...previous, endedOn: String(previous.period || "").split(/\s[-–]\s/)[1] || "" }))
    .sort((a, b) => (parseDay(a.endedOn) ?? 0) - (parseDay(b.endedOn) ?? 0));
  names.forEach((previous, index) => {
    const next = names[index + 1]?.name || profile.legalName || "its current name";
    events.push({ at: parseDay(previous.endedOn), text: `Name changed from ${previous.name} to ${next} on ${chDate(previous.endedOn)}` });
  });
  if (Array.isArray(profile.changes)) {
    for (const change of profile.changes) {
      const on = (change.description.match(new RegExp(`(${CH_DAY.source})\\s*$`)) || [])[1] || change.filedOn;
      events.push({ at: parseDay(on), text: changeLine(change) });
    }
  } else {
    const incorporated = parseDay(profile.incorporatedOn) ?? 0;
    for (const doc of mine.filter((item) => item.requirementKey === "registered_office")) {
      const on = filingDate(doc.label);
      events.push({ at: parseDay(on), text: `Registered office changed to ${profile.registeredOffice || "its current address"} on ${chDate(on)}` });
    }
    for (const officer of officers) {
      const who = displayName(officer.name);
      const role = (officer.role || "officer").toLowerCase();
      if ((parseDay(officer.appointedOn) ?? 0) > incorporated) {
        events.push({ at: parseDay(officer.appointedOn), text: `${who} appointed as a ${role} on ${chDate(officer.appointedOn)}` });
      }
      if (officer.resignedOn) {
        events.push({ at: parseDay(officer.resignedOn), text: `${who} resigned as a ${role} on ${chDate(officer.resignedOn)}` });
      }
    }
    for (const person of pscs) {
      if ((parseDay(person.notifiedOn) ?? 0) > incorporated) {
        events.push({ at: parseDay(person.notifiedOn), text: `${person.name} became a person with significant control on ${chDate(person.notifiedOn)}` });
      }
      if (person.ceasedOn) {
        events.push({ at: parseDay(person.ceasedOn), text: `${person.name} ceased to be a person with significant control on ${chDate(person.ceasedOn)}` });
      }
    }
  }
  return events.sort((a, b) => (a.at ?? 0) - (b.at ?? 0)).map((event) => event.text);
}

/** Declarations and disclosures come only from what this pack holds, so nothing is asserted that was not checked. */
function companyFacts(record, documents, annexNo, { pep, packDay }) {
  const bundle = record.directoryId ? registryBundle(record.directoryId) : null;
  const profile = bundle?.profile || {};
  const officers = bundle?.officers || [];
  const pscs = bundle?.pscs || [];
  const sanctions = bundle?.sanctions;
  const mine = documents.filter((doc) => doc.partyId === record.directoryId);
  const matches = (keys) => mine.filter((doc) => keys.includes(doc.requirementKey) || keys.includes(doc.virtual));
  const has = (...keys) => keys.every((key) => matches([key]).length > 0);
  const annex = (...keys) => annexList(matches(keys).map((doc) => annexNo[doc.key]));
  const result = (value) => (value == null ? "na" : value ? "clear" : "flag");
  const accountsOverdue = /overdue/i.test(profile.accounts || "");
  const statementOverdue = /overdue/i.test(profile.confirmationStatement || "");
  const people = pep.filter((row) => row.roleKey === record.roleKey);
  const insurance = Object.fromEntries(insuranceChecks(record, packDay).map((row) => [row.key, row]));
  const insuranceRow = (key) => [insurance[key]?.result || "flag", insurance[key]?.text || "", annex(insurance[key]?.certificate)];
  const declarations = [
    [result(profile.status ? /^active$/i.test(profile.status) : null), "Active at Companies House", ""],
    [result(profile.accounts ? !accountsOverdue : null), "Accounts up to date", ""],
    [result(profile.confirmationStatement ? !statementOverdue : null), "Confirmation statement up to date", ""],
    [result(sanctions ? !sanctions.hitCount : false), "UK Sanctions List screening", annex("sanctions")],
    ...people.map((person) => [
      person.verified == null
        ? { result: "na" }
        : person.verified
          ? { result: "clear", label: "Verified" }
          : { result: "flag", label: "Not verified" },
      `Companies House identity verification: ${person.name} (${rolesText(person.roles)})${
        person.verified === false && person.verificationDueOn ? `, statement due ${chDate(person.verificationDueOn)}` : ""
      }`,
      "",
    ]),
    ...people.map((person) => [
      person.approvedOn ? { result: person.result } : { result: "na", label: "Pending" },
      `PEP and adverse media screening: ${person.name} (${rolesText(person.roles)}), ${
        person.approvedOn ? `approved by ${person.approvedBy} on ${ukDate(person.approvedOn)}` : "awaiting approval"
      }`,
      "",
    ]),
  ];
  if (record.roleKey === "supplier") {
    declarations.push(
      [result(has("vat")), "VAT registration certificate", annex("vat")],
      insuranceRow("el"),
      insuranceRow("pl"),
      insuranceRow("pi"),
      [result(has("pi_schedule")), "Professional Indemnity policy schedule and wording", annex("pi_schedule")],
      [result(has("bank")), "Bank statement for the account paying workers and HMRC", annex("bank")],
      [result(has("payslip")), "Illustrative payslip", annex("payslip")],
      [
        result(has("payroll_chain")),
        "Payroll chain map, with each PAYE reference and Employer Reference Number (ERN) confirmed",
        annex("payroll_chain"),
      ]
    );
  } else {
    declarations.push(
      [result(has("paye_letter")), "HMRC PAYE registration letter", annex("paye_letter")],
      insuranceRow("el"),
      [result(has("el_schedule")), "Employers’ Liability policy pages naming the SPV", annex("el_schedule")]
    );
  }

  const disclosures = [];
  if (profile.status && !/^active$/i.test(profile.status)) disclosures.push(`Shown as ${profile.status} at Companies House`);
  if (accountsOverdue) disclosures.push("Accounts overdue");
  if (statementOverdue) disclosures.push("Confirmation statement overdue");
  const incorporated = parseDay(profile.incorporatedOn);
  if (incorporated != null && Date.now() - incorporated < 365.25 * 86400000) {
    disclosures.push(`Incorporated on ${chDate(profile.incorporatedOn)}, under a year ago`);
  }
  disclosures.push(...companyChanges(profile, officers, pscs, mine));
  if (sanctions?.hitCount) {
    const names = (sanctions.hits || []).map((hit) => hit.name).join("; ");
    disclosures.push(`${sanctions.hitCount} possible UK Sanctions List match${sanctions.hitCount === 1 ? "" : "es"}: ${names}`);
  }

  const reviewed = mine.filter((doc) => doc.checkedOn).sort((a, b) => b.checkedOn.localeCompare(a.checkedOn));
  return {
    label: record.label,
    companyName: record.companyName,
    roleKey: record.roleKey,
    declarations,
    disclosures,
    reviewer: reviewed.find((doc) => doc.checkedBy)?.checkedBy || "",
    reviewedOn: reviewed[0]?.checkedOn || "",
  };
}

const CERT_LABEL_W = 150;
const CERT_ROW = 22;
const CERT_SIGNATURE_ROW = 52;
const CERT_TABLE_H = CERT_ROW * 4 + CERT_SIGNATURE_ROW;
const CERT_AFTER_H = 16;

/** Where signing stamps the signature and the date, for a signature table starting at `top`. */
export function certificateSignature(top) {
  return {
    x: MARGIN + CERT_LABEL_W + 4,
    y: top - CERT_ROW * 3 - CERT_SIGNATURE_ROW + 5,
    w: CONTENT_W - CERT_LABEL_W - 8,
    h: CERT_SIGNATURE_ROW - 10,
    dateX: MARGIN + CERT_LABEL_W + 6,
    dateY: top - CERT_TABLE_H + 7.5,
  };
}

/** Capitals the first time a company is named, normal case after that. */
function mentions() {
  const seen = new Set();
  return (name, normal) => {
    if (!name) return "";
    const key = String(name).toUpperCase();
    if (seen.has(key)) return normal || normalCase(name);
    seen.add(key);
    return name;
  };
}

/** Lays the certificate out on the current page when it all fits, otherwise on a new one. Returns the signature table's top. */
function addCertificate(writer, letter, { entity, brokerLegal, broker, details, sources, annexNo }) {
  const { font, bold, theme } = writer;
  const name = mentions();
  const legal = brokerLegal || entity?.display_name || "the broker";
  const role = broker?.signer_role === "authorised_signatory" ? "Authorised signatory" : "Director";
  const signer = broker?.signer_name || "The broker’s director";
  const contractor = sources.records.find((record) => record.roleKey === "supplier");
  const supplier = sources.records.find((record) => record.roleKey === "spv");
  const annexFor = (record, key) => {
    const doc = sources.documents.find((item) => item.partyId === record?.directoryId && item.requirementKey === key);
    return doc ? ` (Annex\u00a0${annexNo[doc.key]})` : "";
  };

  const intro = `Given by ${name(legal)} for the contract with ${name(details.client) || "the Client"}. Pack reference ${details.reference}.`;
  const opening = `I, ${signer}, ${role} of ${name(legal)}, certify that:`;
  const companies = [contractor, supplier]
    .filter(Boolean)
    .map((record) => name(record.companyName, record.normalName))
    .join(" and ");
  const hmrc = [
    contractor ? `${name(contractor.companyName, contractor.normalName)}’s payroll chain map and PAYE/ERN confirmation${annexFor(contractor, "payroll_chain")}` : "",
    supplier ? `${name(supplier.companyName, supplier.normalName)}’s HMRC PAYE registration letter${annexFor(supplier, "paye_letter")}` : "",
  ]
    .filter(Boolean)
    .join(" and ");
  const statements = [
    `I have reviewed the Companies House records, UK Sanctions List screening and annexed documents for ${companies || "the companies in this pack"}, including Companies House identity verification and PEP and adverse media screening for every director and PSC.`,
    "Each document was received and checked on the dates in the annex index.",
    `HMRC registration is evidenced by ${hmrc || "the annexed documents"}.`,
    "The declarations and disclosures are complete and accurate. I am not aware of any further matter material to the Client’s assessment of the supply chain.",
  ];
  const companyRow = name(legal);

  const lineCount = (text, indent = 0) => wrapText(text, font, 9.5, CONTENT_W - indent).length;
  const needed =
    43 +
    lineCount(intro) * 13.5 + 8 +
    lineCount(opening) * 13.5 + 6 +
    statements.reduce((sum, statement) => sum + lineCount(statement, 20) * 13.5 + 5, 0) +
    10 + CERT_TABLE_H + CERT_AFTER_H;
  if (!writer.page || writer.y - needed < BODY_BOTTOM) writer.newPage();

  writer.part(`Part ${letter} — Director’s certificate`);
  writer.text(intro, { size: 9.5, after: 8 });
  writer.text(opening, { size: 9.5, after: 6 });
  statements.forEach((statement, index) => {
    wrapText(statement, font, 9.5, CONTENT_W - 20).forEach((line, n) => {
      if (n === 0) writer.draw(`${index + 1}.`, MARGIN, writer.y - 9.5, { size: 9.5, font: bold });
      writer.draw(line, MARGIN + 20, writer.y - 9.5, { size: 9.5 });
      writer.y -= 13.5;
    });
    writer.y -= 5;
  });
  writer.y -= 10;

  const page = writer.page;
  const certTop = writer.y;
  const rows = [
    ["Name", signer, CERT_ROW],
    ["Position", role, CERT_ROW],
    ["Company", companyRow, CERT_ROW],
    ["Signature", "", CERT_SIGNATURE_ROW],
    ["Date signed", "", CERT_ROW],
  ];
  let top = certTop;
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
  writer.y = certTop - CERT_TABLE_H - CERT_AFTER_H;
  return certTop;
}

function writeIndex(writer, sections, annexNo, titles) {
  writer.newPage();
  writer.part("Annex index");
  for (const section of sections) {
    writer.sub(sectionTitle(section));
    writer.table(
      [
        { label: "Annex", width: CONTENT_W - 180 },
        { label: "Pages", width: 50, align: "center" },
        { label: "Received", width: 65, align: "center" },
        { label: "Checked", width: 65, align: "center" },
      ],
      section.items.map((item) => [
        annexCaption(annexNo[item.doc.key], titles[item.doc.key]),
        pageRange(item),
        ukDate(item.doc.receivedOn) || "—",
        ukDate(item.doc.checkedOn) || "—",
      ]),
      { size: 8 }
    );
  }
}

/** Leading page for one company's evidence, headed like its Part in the body and in the index. */
function addSectionDivider(writer, section, annexNo) {
  const { font, bold, theme } = writer;
  const page = writer.newPage();
  const { record } = section;
  const first = annexNo[section.items[0].doc.key];
  const last = annexNo[section.items[section.items.length - 1].doc.key];
  let y = 650;
  const line = (text, size, face, color, gap) => {
    for (const row of wrapText(text, face, size, CONTENT_W)) {
      page.drawText(row, { x: MARGIN, y, size, font: face, color });
      y -= size + gap;
    }
  };
  line(first === last ? `ANNEX ${first}` : `ANNEXES ${first}–${last}`, 9, bold, theme.muted, 24);
  line(`PART ${section.letter} — ${record.label.toUpperCase()}`, 26, bold, theme.accent, 10);
  line(record.companyName, 18, bold, theme.ink, 8);
  if (record.companyNumber) line(`Company number ${record.companyNumber}`, 10, font, theme.muted, 6);
  page.drawRectangle({ x: MARGIN, y: y - 4, width: 80, height: 3, color: theme.accent });
  writer.y = y - 30;
}

function drawCaption(page, { font, bold, theme }, caption, continued = false) {
  if (continued) {
    const line = wrapText(`${caption} (continued)`, font, 8, CONTENT_W)[0];
    page.drawText(line, { x: MARGIN, y: BODY_TOP - 9, size: 8, font, color: theme.muted });
    return;
  }
  const line = wrapText(caption, bold, 9.5, CONTENT_W)[0];
  page.drawText(line, { x: MARGIN, y: BODY_TOP - 10, size: 9.5, font: bold, color: theme.ink });
}

async function addAnnexPages(out, writer, item, caption, fonts) {
  const { theme } = fonts;
  const bottom = BODY_BOTTOM + 4;
  if (item.virtual) {
    const page = writer.newPage();
    drawCaption(page, fonts, caption);
    writer.y = BODY_TOP - 26;
    writeSanctions(writer, registryBundle(item.doc.partyId)?.sanctions);
    return;
  }
  if (item.image) {
    const page = out.addPage([PAGE.w, PAGE.h]);
    drawCaption(page, fonts, caption);
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
    drawCaption(page, fonts, caption, n > 0);
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
    ["List", `UK Sanctions List published ${listDate(sanctions.listedOn) || "—"}`],
    ["Source", sanctions.listUrl || "https://sanctionslist.fcdo.gov.uk/"],
    ["Searched", ukDate(sanctions.searchedAt) || "—"],
    ["Company", query.companyName || "—"],
    ["Company number", query.companyNumber || "—"],
    ...((query.previousNames || []).length ? [["Previous names", query.previousNames.join("; ")]] : []),
    ["Directors and PSCs", (query.people || []).join("; ") || "—"],
    [
      "Result",
      sanctions.hitCount
        ? { text: `Flag, ${sanctions.hitCount} possible match${sanctions.hitCount === 1 ? "" : "es"}`, color: writer.theme.alert, bold: true }
        : { text: "Clear", bold: true, color: writer.theme.ok },
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

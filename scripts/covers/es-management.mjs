// Builds E Street Management's contract front and back covers, and its brand SVG, from the
// logo artwork. Layout follows ES-Management-Terms-of-Business-2026-3-Way.pdf.
//
//   node scripts/covers/es-management.mjs <ES-Management-logo.ai> <out-dir>
//
// Values that change per contract are named text fields; see addTemplateCover in
// server/src/packLayout.js for how they are filled.
import fs from "node:fs";
import path from "node:path";
import {
  PDFArray,
  PDFDocument,
  PDFName,
  PDFRawStream,
  StandardFonts,
  TextAlignment,
  decodePDFRawStream,
  rgb,
  setCharacterSpacing,
} from "pdf-lib";

const [aiPath, outDir] = process.argv.slice(2);
if (!aiPath || !outDir) {
  console.error("Usage: node scripts/covers/es-management.mjs <ES-Management-logo.ai> <out-dir>");
  process.exit(1);
}

const A4 = [595.28, 841.89];
const hex = (value) => {
  const n = parseInt(value.replace("#", ""), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};
const BLUE = "#3d87c7";
const ORANGE = "#fcb017";
const INK = "#353535";
const MUTED = "#6b6f76";
const RULE = "#dfe4ea";
const CHIP = "#f3f6f9";
const WHITE = "#ffffff";
// White text and rules at the sample's opacities, flattened onto the dark background.
const ON_DARK = { label: "#9a9a9a", soft: "#c6c6c6", ref: "#aeaeae", footer: "#909090", rule: "#4d4d4d", divider: "#5d5d5d" };
const ON_INK = { label: "#a4a4a4", divider: "#5d5d5d" };

const LOGO_BOX = { left: 1519.89, bottom: 1083.4, right: 2986.98, top: 2230.12 };
const LOGO_RATIO = (LOGO_BOX.right - LOGO_BOX.left) / (LOGO_BOX.top - LOGO_BOX.bottom);
const CAP = 0.718;

const rgbOp = (value) => {
  const c = hex(value);
  return `${c.red.toFixed(3)} ${c.green.toFixed(3)} ${c.blue.toFixed(3)} rg`;
};

function pageSource(doc, page) {
  const contents = page.node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray().map((ref) => doc.context.lookup(ref)) : [contents];
  return streams
    .map((stream) =>
      Buffer.from(stream instanceof PDFRawStream ? decodePDFRawStream(stream).decode() : stream.getContents()).toString("latin1")
    )
    .join("\n");
}

/** The logo page from the .ai with its CMYK fills set to the brand RGB colours and the wordmark in `wordmark`. */
async function logoDoc(aiBytes, wordmark) {
  const ai = await PDFDocument.load(aiBytes);
  const page = ai.getPage(0);
  const source = pageSource(ai, page)
    .replace(/\/OC\s*\/MC0\s*BDC/, "")
    .replace(/EMC\s*$/, "")
    .replace(/0 0\.348 1 0 k/g, rgbOp(ORANGE))
    .replace(/0\.747 0\.389 0 0 k/g, rgbOp(BLUE))
    .replace(/0\.692 0\.629 0\.618 0\.566 k/g, rgbOp(wordmark));
  page.node.set(PDFName.of("Contents"), ai.context.register(ai.context.flateStream(Buffer.from(source, "latin1"))));
  page.node.Resources().delete(PDFName.of("Properties"));
  for (const key of ["PieceInfo", "Metadata", "Thumb", "LastModified"]) page.node.delete(PDFName.of(key));
  return { ai, page, source };
}

/** The six filled shapes of the mark as SVG paths, in a box whose top-left is the mark's top-left. */
function markPaths(source) {
  const paths = [];
  const block = /q 1 0 0 1 ([\d.]+) ([\d.]+) cm\s+([\s\S]*?)\s+f\s+Q/g;
  const fills = [];
  let fill = null;
  const fillAt = [];
  for (const match of source.matchAll(/(\S+ \S+ \S+) rg|q 1 0 0 1/g)) {
    if (match[1]) fill = match[1];
    else fillAt.push(fill);
  }
  let index = 0;
  for (const [, tx, ty, body] of source.matchAll(block)) {
    const ox = Number(tx);
    const oy = Number(ty);
    const tokens = body.trim().split(/\s+/);
    const parts = [];
    let operands = [];
    for (const token of tokens) {
      if (/^[-\d.]+$/.test(token)) {
        operands.push(Number(token));
        continue;
      }
      const points = [];
      for (let i = 0; i < operands.length; i += 2) points.push([ox + operands[i], oy + operands[i + 1]]);
      if (token === "m") parts.push(["M", points]);
      else if (token === "l") parts.push(["L", points]);
      else if (token === "c") parts.push(["C", points]);
      else if (token === "h") parts.push(["Z", []]);
      operands = [];
    }
    paths.push({ parts, fill: fillAt[index] });
    fills.push(fillAt[index]);
    index += 1;
  }
  const all = paths.flatMap((p) => p.parts.flatMap(([, points]) => points));
  const minX = Math.min(...all.map(([x]) => x));
  const maxX = Math.max(...all.map(([x]) => x));
  const minY = Math.min(...all.map(([, y]) => y));
  const maxY = Math.max(...all.map(([, y]) => y));
  const fmt = (n) => Number(n.toFixed(2));
  const shapes = paths.map(({ parts, fill: op }) => ({
    color: op === rgbOp(ORANGE).replace(/ rg$/, "") ? ORANGE : BLUE,
    d: parts
      .map(([cmd, points]) => cmd + points.map(([x, y]) => `${fmt(x - minX)},${fmt(maxY - y)}`).join(" "))
      .join(" "),
  }));
  return { shapes, width: maxX - minX, height: maxY - minY };
}

function markSvg(mark) {
  const body = mark.shapes.map((s) => `  <path fill="${s.color}" d="${s.d}"/>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${mark.width.toFixed(2)} ${mark.height.toFixed(2)}">\n${body}\n</svg>\n`;
}

function drawMark(page, mark, { x, top, height, color, opacity = 1 }) {
  const scale = height / mark.height;
  for (const shape of mark.shapes) {
    page.drawSvgPath(shape.d, { x, y: top, scale, color: hex(color || shape.color), opacity, borderWidth: 0 });
  }
}

function tracked(page, text, { x, y, size, font, color, tracking }) {
  page.pushOperators(setCharacterSpacing(size * tracking));
  page.drawText(text, { x, y, size, font, color: hex(color) });
  page.pushOperators(setCharacterSpacing(0));
}

function text(page, value, { x, y, size, font, color }) {
  page.drawText(value, { x, y, size, font, color: hex(color) });
}

function chip(page, label, { x, y, font }) {
  const size = 7;
  const w = font.widthOfTextAtSize(label, size) + 22;
  const h = 17;
  const r = h / 2;
  const d = `M ${r} 0 H ${w - r} A ${r} ${r} 0 0 1 ${w - r} ${h} H ${r} A ${r} ${r} 0 0 1 ${r} 0 Z`;
  page.drawSvgPath(d, { x, y: y + h, color: hex(CHIP), borderColor: hex(RULE), borderWidth: 0.75 });
  text(page, label, { x: x + 11, y: y + 6.3, size, font, color: INK });
  return x + w + 6;
}

const lead = (size) => (size >= 18 ? 1.03 : size >= 10 ? 1.58 : 1.45);

/**
 * Adds a named field. Single-line fields are placed by baseline; multi-line ones by first baseline
 * and line count. `tracking` (in em) is stored in the field's default appearance as Tc.
 */
function slot(form, page, fonts, name, o) {
  const font = o.bold ? fonts.bold : fonts.regular;
  let y;
  let height;
  if (o.lines) {
    const step = o.size * lead(o.size);
    const top = o.baseline + (step + o.size * CAP) / 2;
    height = step * o.lines;
    y = top - height;
  } else {
    height = o.size * 1.6;
    y = o.baseline - (height - o.size * CAP) / 2;
  }
  if (o.top != null) {
    y = o.top - o.height;
    height = o.height;
  } else if (o.height) {
    y += height - o.height;
    height = o.height;
  }
  const field = form.createTextField(name);
  if (o.lines || o.multiline) field.enableMultiline();
  field.setText(o.text);
  field.addToPage(page, {
    x: o.x,
    y,
    width: o.width,
    height,
    font,
    textColor: hex(o.color),
    backgroundColor: undefined,
    borderColor: undefined,
    borderWidth: 0,
  });
  field.setAlignment(o.align === "right" ? TextAlignment.Right : TextAlignment.Left);
  field.setFontSize(o.size);
  const widget = field.acroField.getWidgets()[0];
  widget.getOrCreateBorderStyle().setWidth(0);
  field.updateAppearances(font);
  if (o.tracking) {
    const da = field.acroField.getDefaultAppearance();
    field.acroField.setDefaultAppearance(`${da}\n${Number((o.size * o.tracking).toFixed(3))} Tc`);
  }
  if (o.rule) {
    const c = hex(o.rule);
    widget.getOrCreateAppearanceCharacteristics().setBorderColor([c.red, c.green, c.blue]);
  }
}

async function frontCover(aiBytes, mark) {
  const doc = await PDFDocument.create();
  doc.setTitle("E Street Management contract front cover");
  const page = doc.addPage(A4);
  const fonts = { regular: await doc.embedFont(StandardFonts.Helvetica), bold: await doc.embedFont(StandardFonts.HelveticaBold) };
  const { regular, bold } = fonts;
  const form = doc.getForm();
  const { page: logoPage } = await logoDoc(aiBytes, INK);
  const logo = await doc.embedPage(logoPage, LOGO_BOX);

  page.drawPage(logo, { x: 45, y: 727.6, width: 95.4, height: 95.4 / LOGO_RATIO });
  slot(form, page, fonts, "kicker", { x: 300, width: 249.6, baseline: 791.7, size: 6.4, tracking: 0.3, color: INK, align: "right", text: "TERMS OF BUSINESS" });
  slot(form, page, fonts, "subtitle", { x: 250, width: 299.6, baseline: 775.9, size: 8.5, bold: true, color: MUTED, align: "right", text: "[Shape] terms · [Party roles]" });
  slot(form, page, fonts, "reference", { x: 250, width: 299.6, baseline: 763.2, size: 8.5, bold: true, color: BLUE, align: "right", text: "Ref. [Reference] · Prepared [Prepared]" });

  page.drawRectangle({ x: 45, y: 672.7, width: 33.5, height: 1.6, color: hex(ORANGE) });
  tracked(page, "E STREET MANAGEMENT", { x: 90.7, y: 670.9, size: 8.5, font: bold, color: BLUE, tracking: 0.2 });
  slot(form, page, fonts, "title", { x: 45.4, width: 330, baseline: 611.7, lines: 2, height: 106, size: 44, tracking: -0.022, bold: true, color: INK, text: "Terms of business" });
  slot(form, page, fonts, "summary", {
    x: 45.4,
    width: 330,
    baseline: 523.9,
    lines: 3,
    size: 10.6,
    color: MUTED,
    text: "Terms of business between [the parties] governing the management services provided by [Broker name], as Broker, around payroll.",
  });

  tracked(page, "THE PARTIES", { x: 45.4, y: 399.4, size: 6.2, font: regular, color: MUTED, tracking: 0.3 });
  slot(form, page, fonts, "parties", {
    x: 45,
    width: 204.75,
    top: 386.7,
    height: 178.2,
    size: 9.2,
    bold: true,
    color: INK,
    rule: RULE,
    multiline: true,
    text: "Client: [Client]\nContractor: [Contractor]\nBroker: [Broker]\nReference: [Reference]\nDated: Date of last signature",
  });

  let x = chip(page, "Client Management", { x: 44.7, y: 155.4, font: bold });
  chip(page, "Compliance Support", { x, y: 155.4, font: bold });
  x = chip(page, "Payment Coordination", { x: 44.7, y: 131.4, font: bold });
  chip(page, "Consultancy", { x, y: 131.4, font: bold });

  drawMark(page, mark, { x: 261.5, top: 383.6, height: 254.2 });

  page.drawRectangle({ x: 0, y: 0, width: A4[0], height: 68.4, color: hex(INK) });
  page.drawRectangle({ x: 0, y: 68.4, width: 112.7, height: 3.5, color: hex(ORANGE) });
  page.drawRectangle({ x: 112.7, y: 68.4, width: A4[0] - 112.7, height: 3.5, color: hex(BLUE) });
  for (const [label, at] of [["COMPANY NUMBER", 45.4], ["REGISTERED OFFICE", 133.4], ["TELEPHONE", 353.6], ["EMAIL", 429.4]]) {
    tracked(page, label, { x: at, y: 38.7, size: 5.8, font: bold, color: ON_INK.label, tracking: 0.13 });
  }
  for (const at of [122.6, 342.8, 418.3]) {
    page.drawRectangle({ x: at, y: 24.2, width: 0.75, height: 19.7, color: hex(ON_INK.divider) });
  }
  slot(form, page, fonts, "company_number", { x: 45.4, width: 76, baseline: 25.9, size: 8.2, bold: true, color: ORANGE, text: "[Company number]" });
  slot(form, page, fonts, "registered_office", { x: 133.4, width: 203, baseline: 25.9, size: 8.2, bold: true, color: WHITE, text: "[Registered office]" });
  text(page, "03338 800 292", { x: 353.6, y: 25.9, size: 8.2, font: bold, color: WHITE });
  text(page, "support@es.management", { x: 429.4, y: 25.9, size: 8.2, font: bold, color: WHITE });

  return doc.save({ updateFieldAppearances: false });
}

async function backCover(aiBytes, mark) {
  const doc = await PDFDocument.create();
  doc.setTitle("E Street Management contract back cover");
  const page = doc.addPage(A4);
  const fonts = { regular: await doc.embedFont(StandardFonts.Helvetica), bold: await doc.embedFont(StandardFonts.HelveticaBold) };
  const { regular, bold } = fonts;
  const form = doc.getForm();
  const { page: logoPage } = await logoDoc(aiBytes, WHITE);
  const logo = await doc.embedPage(logoPage, LOGO_BOX);

  page.drawRectangle({ x: 0, y: 0, width: A4[0], height: A4[1], color: hex(INK) });
  drawMark(page, mark, { x: 141, top: 369, height: 442.8, color: WHITE, opacity: 0.045 });
  page.drawPage(logo, { x: 45, y: 722.3, width: 95.4, height: 95.4 / LOGO_RATIO });
  slot(form, page, fonts, "kicker", { x: 300, width: 249.6, baseline: 785.7, size: 6.4, tracking: 0.3, color: WHITE, align: "right", text: "TERMS OF BUSINESS" });
  slot(form, page, fonts, "reference", { x: 250, width: 299.6, baseline: 770.7, size: 8.5, bold: true, color: ON_DARK.ref, align: "right", text: "Ref. [Reference] · Prepared [Prepared]" });

  page.drawRectangle({ x: 45, y: 684.0, width: 33.5, height: 1.6, color: hex(ORANGE) });
  tracked(page, "ABOUT E STREET MANAGEMENT", { x: 90.7, y: 682.2, size: 8.5, font: bold, color: ORANGE, tracking: 0.2 });
  tracked(page, "We do not run payroll.", { x: 45.4, y: 648.4, size: 20, font: bold, color: WHITE, tracking: -0.014 });
  tracked(page, "We manage the services around it.", { x: 45.4, y: 625.9, size: 20, font: bold, color: WHITE, tracking: -0.014 });
  [
    "A specialist management and consultancy company acting as the management layer",
    "between payroll providers and their clients — organising onboarding, communication,",
    "compliance administration and payment coordination so providers can focus on payroll",
    "processing.",
  ].forEach((line, i) => text(page, line, { x: 45.4, y: 599.7 - i * 14.27, size: 9, font: regular, color: ON_DARK.soft }));

  const section = (label, x, y) => tracked(page, label, { x, y, size: 6.2, font: regular, color: ORANGE, tracking: 0.3 });
  const label = (value, x, y) => tracked(page, value, { x, y, size: 6.6, font: bold, color: ON_DARK.label, tracking: 0.12 });
  const value = (v, x, y, color = WHITE) => text(page, v, { x, y, size: 8.6, font: bold, color });
  const rules = (x, ys) => ys.forEach((y) => page.drawRectangle({ x, y, width: 232.5, height: 0.75, color: hex(ON_DARK.rule) }));

  section("REGISTERED DETAILS", 45.4, 501.4);
  rules(45, [491.7, 465.4, 439.9, 413.7, 388.2, 362.7, 324.4]);
  label("LEGAL NAME", 45.4, 475.9);
  slot(form, page, fonts, "legal_name", { x: 133.2, width: 144, baseline: 475.9, size: 8.6, bold: true, color: WHITE, text: "[Legal name]" });
  label("TRADING AS", 45.4, 450.4);
  value("ES Management", 133.2, 450.4);
  label("ROLE", 45.4, 424.2);
  value("Broker", 133.2, 424.2);
  label("COMPANY NO.", 45.4, 398.7);
  slot(form, page, fonts, "company_number", { x: 133.2, width: 144, baseline: 398.7, size: 8.6, bold: true, color: WHITE, text: "[Company number]" });
  label("REGISTERED IN", 45.4, 372.4);
  value("England & Wales", 133.2, 372.4);
  label("REGISTERED", 45.4, 346.9);
  label("OFFICE", 45.4, 339.4);
  slot(form, page, fonts, "registered_office", { x: 133.2, width: 144, baseline: 346.9, lines: 2, size: 8.6, bold: true, color: WHITE, text: "[Registered office]" });

  section("CONTACT", 317.5, 501.4);
  rules(317.25, [491.7, 465.4, 439.9, 413.7, 364.2]);
  label("TELEPHONE", 317.5, 475.9);
  value("03338 800 292", 405.3, 475.9);
  label("EMAIL", 317.5, 450.4);
  value("support@es.management", 405.3, 450.4);
  label("WEBSITE", 317.5, 424.2);
  value("es.management", 405.3, 424.2);
  label("NOTICES TO", 317.5, 398.7);
  slot(form, page, fonts, "notices", { x: 405.3, width: 144, baseline: 398.7, lines: 2, size: 8.6, bold: true, color: WHITE, text: "[Registered office]" });

  section("DOCUMENT CONTROL", 317.5, 331.9);
  rules(317.25, [322.2, 295.9, 270.4, 244.2, 218.7, 192.4]);
  label("DOCUMENT", 317.5, 306.4);
  slot(form, page, fonts, "document", { x: 405.3, width: 144, baseline: 306.4, size: 8.6, bold: true, color: WHITE, text: "[Document]" });
  label("PARTIES", 317.5, 280.2);
  slot(form, page, fonts, "parties_list", { x: 405.3, width: 144, baseline: 280.2, size: 8.6, bold: true, color: WHITE, text: "[Parties]" });
  label("REFERENCE", 317.5, 254.7);
  slot(form, page, fonts, "reference_value", { x: 405.3, width: 144, baseline: 254.7, size: 8.6, bold: true, color: ORANGE, text: "[Reference]" });
  label("TYPE", 317.5, 229.2);
  slot(form, page, fonts, "shape", { x: 405.3, width: 144, baseline: 229.2, size: 8.6, bold: true, color: WHITE, text: "[Shape]" });
  label("PREPARED", 317.5, 202.9);
  slot(form, page, fonts, "prepared", { x: 405.3, width: 144, baseline: 202.9, size: 8.6, bold: true, color: WHITE, text: "[Prepared]" });

  slot(form, page, fonts, "legal_note", {
    x: 45.4,
    width: 504.2,
    baseline: 109.2,
    lines: 4,
    size: 6.4,
    color: ON_DARK.label,
    text:
      "[Legal name] is a company registered in England & Wales under company number [Company number], with its registered office at [Registered office]. " +
      "E Street Management does not act as a payroll provider, calculate wages, issue payslips or process tax deductions; it provides management, consultancy and coordination services around payroll. " +
      "This document is confidential and intended solely for the parties named on the cover. © [Legal name]. All rights reserved.",
  });

  page.drawRectangle({ x: 0, y: 62.7, width: A4[0], height: 0.75, color: hex(ON_DARK.rule) });
  for (const [name, at] of [["WEBSITE", 45.4], ["TELEPHONE", 128.4], ["EMAIL", 204.2], ["REGISTERED OFFICE", 326.0]]) {
    tracked(page, name, { x: at, y: 35.7, size: 5.8, font: bold, color: ON_DARK.footer, tracking: 0.13 });
  }
  for (const at of [117.75, 193.5, 315]) {
    page.drawRectangle({ x: at, y: 20.7, width: 0.75, height: 20.2, color: hex(ON_DARK.divider) });
  }
  text(page, "es.management", { x: 45.4, y: 22.9, size: 8.2, font: bold, color: ORANGE });
  text(page, "03338 800 292", { x: 128.4, y: 22.9, size: 8.2, font: bold, color: WHITE });
  text(page, "support@es.management", { x: 204.2, y: 22.9, size: 8.2, font: bold, color: WHITE });
  slot(form, page, fonts, "footer_office", { x: 326, width: 223.6, baseline: 22.9, size: 8.2, bold: true, color: WHITE, text: "[Registered office]" });

  return doc.save({ updateFieldAppearances: false });
}

const aiBytes = fs.readFileSync(aiPath);
const { source } = await logoDoc(aiBytes, INK);
const mark = markPaths(source);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "ES_MANAGEMENT_CONTRACT_FRONT_COVER.pdf"), await frontCover(aiBytes, mark));
fs.writeFileSync(path.join(outDir, "ES_MANAGEMENT_CONTRACT_BACK_COVER.pdf"), await backCover(aiBytes, mark));
fs.writeFileSync(path.join(outDir, "ES-Management-mark.svg"), markSvg(mark));
console.log(`mark ${mark.width.toFixed(1)} x ${mark.height.toFixed(1)}, ${mark.shapes.length} shapes`);

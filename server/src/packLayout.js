import {
  PDFArray,
  PDFDocument,
  PDFEmbeddedPage,
  PDFName,
  PDFRawStream,
  decodePDFRawStream,
  degrees,
  rgb,
} from "pdf-lib";
import { extractTextItems } from "./detectFields.js";
import { readBytes } from "./storage.js";

export const PAGE = { w: 595.28, h: 841.89 };
export const MARGIN = 56;
export const CONTENT_W = PAGE.w - MARGIN * 2;
export const BODY_TOP = 752;
export const BODY_BOTTOM = 64;

const WIN_ANSI_EXTRA = "‘’‚“”„–—•…€™‹›ŠšŒœŽžŸ†‡‰ƒ";

/** Standard PDF fonts draw WinAnsi only; anything else becomes a space. */
export function packText(value) {
  return Array.from(String(value ?? ""))
    .map((ch) => {
      const code = ch.codePointAt(0);
      if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || WIN_ANSI_EXTRA.includes(ch)) return ch;
      return code === 0x2032 ? "'" : " ";
    })
    .join("");
}

export function wrapText(text, font, size, width) {
  const lines = [];
  for (const paragraph of String(text ?? "").split("\n")) {
    let current = "";
    for (const word of packText(paragraph).split(/\s+/).filter(Boolean)) {
      const next = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= width) {
        current = next;
        continue;
      }
      if (current) lines.push(current);
      current = word;
      while (current.length > 1 && font.widthOfTextAtSize(current, size) > width) {
        let cut = current.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(current.slice(0, cut), size) > width) cut -= 1;
        lines.push(current.slice(0, cut));
        current = current.slice(cut);
      }
    }
    lines.push(current);
  }
  return lines;
}

export function packTheme(entity) {
  let brand = {};
  try {
    brand = JSON.parse(entity?.brand_json || "{}");
  } catch {
    brand = {};
  }
  const match = String(brand.primary || "").match(/^#?([0-9a-f]{6})$/i);
  const n = match ? parseInt(match[1], 16) : 0x0074ff;
  const [r, g, b] = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  return {
    accent: rgb(r, g, b),
    tint: rgb(1 - (1 - r) * 0.14, 1 - (1 - g) * 0.14, 1 - (1 - b) * 0.14),
    ink: rgb(0.1, 0.12, 0.16),
    muted: rgb(0.42, 0.46, 0.52),
    rule: rgb(0.76, 0.79, 0.83),
    alert: rgb(0.75, 0.1, 0.1),
  };
}

/** "UNION PAYROLL" style: first word bold, the rest regular. */
export function wordmarkParts(name) {
  const words = String(name || "").toUpperCase().split(/\s+/).filter(Boolean);
  return words.length > 1 ? [words[0], words.slice(1).join(" ")] : words;
}

/**
 * Header and footer on every inner page, alternating like a printed pack:
 * odd pages carry the rule then the logo mark, even pages the wordmark then the rule;
 * the page number sits on the outer edge.
 */
export function drawFrame(page, { pageNumber, theme, font, bold, logo, wordmark, footer, watermark = true }) {
  const odd = pageNumber % 2 === 1;
  const barY = 792;
  const barH = 3.5;
  if (logo && watermark) {
    const h = 150;
    const w = (logo.width / logo.height) * h;
    page.drawImage(logo, { x: MARGIN - 28, y: BODY_BOTTOM + 6, width: w, height: h, opacity: 0.04 });
  }
  if (odd || !wordmark.length) {
    page.drawRectangle({ x: 0, y: barY, width: PAGE.w - MARGIN - 64, height: barH, color: theme.accent });
    if (logo) {
      const h = 30;
      const w = (logo.width / logo.height) * h;
      page.drawImage(logo, { x: PAGE.w - MARGIN - w, y: barY + barH / 2 - h / 2, width: w, height: h });
    }
  } else {
    const size = 20;
    let x = MARGIN;
    wordmark.forEach((part, index) => {
      const face = index === 0 ? bold : font;
      page.drawText(packText(part), { x, y: barY - 5.5, size, font: face, color: theme.accent });
      x += face.widthOfTextAtSize(packText(part), size) + (index < wordmark.length - 1 ? 5 : 0);
    });
    page.drawRectangle({ x: x + 12, y: barY, width: PAGE.w - x - 12, height: barH, color: theme.accent });
  }
  const label = packText(footer);
  const number = String(pageNumber);
  const numberW = bold.widthOfTextAtSize(number, 8);
  const labelW = font.widthOfTextAtSize(label, 7);
  if (odd) {
    page.drawText(number, { x: PAGE.w - MARGIN - numberW, y: 34, size: 8, font: bold, color: theme.ink });
    page.drawText(label, { x: PAGE.w - MARGIN - numberW - 14 - labelW, y: 34.5, size: 7, font, color: theme.muted });
  } else {
    page.drawText(number, { x: MARGIN, y: 34, size: 8, font: bold, color: theme.ink });
    page.drawText(label, { x: MARGIN + numberW + 14, y: 34.5, size: 7, font, color: theme.muted });
  }
}

/** Flowing writer for the generated pages: part titles, sub-headings, text and bordered tables. */
export class PackWriter {
  constructor(doc, { font, bold, theme }) {
    this.doc = doc;
    this.font = font;
    this.bold = bold;
    this.theme = theme;
    this.page = null;
    this.y = BODY_TOP;
  }

  newPage() {
    this.page = this.doc.addPage([PAGE.w, PAGE.h]);
    this.y = BODY_TOP;
    return this.page;
  }

  ensure(height) {
    if (!this.page || this.y - height < BODY_BOTTOM) this.newPage();
  }

  draw(text, x, y, { size = 9, font = this.font, color = this.theme.ink } = {}) {
    this.page.drawText(packText(text), { x, y, size, font, color });
  }

  part(title) {
    this.ensure(90);
    if (this.y < BODY_TOP) this.y -= 18;
    this.draw(String(title).toUpperCase(), MARGIN, this.y - 13, { size: 13, font: this.bold, color: this.theme.accent });
    this.y -= 13 + 12;
  }

  sub(title) {
    this.ensure(80);
    this.y -= 6;
    this.draw(title, MARGIN, this.y - 10, { size: 10, font: this.bold });
    this.y -= 10 + 8;
  }

  text(value, { size = 9, font = this.font, color = this.theme.ink, indent = 0, after = 6 } = {}) {
    for (const line of wrapText(value, font, size, CONTENT_W - indent)) {
      this.ensure(size + 4);
      this.draw(line, MARGIN + indent, this.y - size, { size, font, color });
      this.y -= size + 4;
    }
    this.y -= after;
  }

  /**
   * Bordered table. Columns are { label, width } with widths summing to the content width.
   * A cell is a string, { text, bold, color }, or { yesNo: boolean }.
   */
  table(columns, rows, { header = true, labelColumn = false, size = 8.5 } = {}) {
    const pad = 5;
    const lineH = size + 3;
    const xs = [];
    columns.reduce((x, column) => {
      xs.push(x);
      return x + column.width;
    }, MARGIN);
    const faceFor = (cell, index, isHeader) =>
      isHeader || (typeof cell === "object" && cell?.bold) || (labelColumn && index === 0) ? this.bold : this.font;
    const layout = (cells, isHeader) => {
      const lines = cells.map((cell, index) =>
        cell && typeof cell === "object" && "yesNo" in cell
          ? [""]
          : wrapText(typeof cell === "object" && cell ? cell.text : cell ?? "", faceFor(cell, index, isHeader), size, columns[index].width - pad * 2)
      );
      return { lines, height: Math.max(...lines.map((l) => l.length)) * lineH + pad * 2 - 2 };
    };
    const drawRow = (cells, isHeader) => {
      const { lines, height } = layout(cells, isHeader);
      const top = this.y;
      cells.forEach((cell, index) => {
        this.page.drawRectangle({
          x: xs[index],
          y: top - height,
          width: columns[index].width,
          height,
          color: isHeader ? this.theme.tint : undefined,
          borderColor: this.theme.rule,
          borderWidth: 0.6,
        });
        if (cell && typeof cell === "object" && "yesNo" in cell) {
          this.yesNo(xs[index] + pad, top - pad - size + 1, cell.yesNo, size);
          return;
        }
        const color = (typeof cell === "object" && cell?.color) || this.theme.ink;
        lines[index].forEach((line, n) => {
          this.draw(line, xs[index] + pad, top - pad - size + 1 - n * lineH, {
            size,
            font: faceFor(cell, index, isHeader),
            color,
          });
        });
      });
      this.y -= height;
    };
    const headerCells = columns.map((column) => column.label);
    const headerHeight = header ? layout(headerCells, true).height : 0;
    const firstHeight = rows.length ? layout(rows[0], false).height : 0;
    this.ensure(headerHeight + firstHeight + 4);
    if (header) drawRow(headerCells, true);
    for (const row of rows) {
      const { height } = layout(row, false);
      if (this.y - height < BODY_BOTTOM) {
        this.newPage();
        if (header) drawRow(headerCells, true);
      }
      drawRow(row, false);
    }
    this.y -= 12;
  }

  yesNo(x, baseline, value, size) {
    const box = size - 1;
    const mark = (bx, checked) => {
      this.page.drawRectangle({ x: bx, y: baseline - 1, width: box, height: box, borderColor: this.theme.ink, borderWidth: 0.6 });
      if (!checked) return;
      const color = value ? this.theme.ink : this.theme.alert;
      this.page.drawLine({ start: { x: bx + 1.5, y: baseline + 0.5 }, end: { x: bx + box - 1.5, y: baseline + box - 2.5 }, thickness: 0.9, color });
      this.page.drawLine({ start: { x: bx + 1.5, y: baseline + box - 2.5 }, end: { x: bx + box - 1.5, y: baseline + 0.5 }, thickness: 0.9, color });
    };
    mark(x, value);
    this.draw("Yes", x + box + 3, baseline, { size, color: this.theme.ink });
    const noX = x + box + 3 + this.font.widthOfTextAtSize("Yes", size) + 10;
    mark(noX, !value);
    this.draw("No", noX + box + 3, baseline, { size, color: value ? this.theme.ink : this.theme.alert });
  }
}

/** Draws a source page (or image) scaled into the body of an annex page, framed, honouring /Rotate. */
export function placeInBody(page, embedded, { top, bottom, rotation = 0, rule }) {
  const angle = ((rotation % 360) + 360) % 360;
  const turned = angle === 90 || angle === 270;
  const vw = turned ? embedded.height : embedded.width;
  const vh = turned ? embedded.width : embedded.height;
  const scale = Math.min(CONTENT_W / vw, (top - bottom) / vh, 1.25);
  const w = vw * scale;
  const h = vh * scale;
  const left = MARGIN + (CONTENT_W - w) / 2;
  const base = top - h;
  const sw = embedded.width * scale;
  const sh = embedded.height * scale;
  const draw = embedded instanceof PDFEmbeddedPage ? "drawPage" : "drawImage";
  const options =
    angle === 90
      ? { x: left, y: base + sw, rotate: degrees(-90) }
      : angle === 270
        ? { x: left + sh, y: base, rotate: degrees(90) }
        : angle === 180
          ? { x: left + sw, y: base + sh, rotate: degrees(180) }
          : { x: left, y: base };
  page[draw](embedded, { ...options, width: sw, height: sh });
  page.drawRectangle({ x: left, y: base, width: w, height: h, borderColor: rule, borderWidth: 0.6 });
}

function stripPageText(doc, page) {
  const contents = page.node.Contents();
  if (!contents) return;
  const streams =
    contents instanceof PDFArray ? contents.asArray().map((ref) => doc.context.lookup(ref)) : [contents];
  const source = streams
    .map((stream) =>
      Buffer.from(stream instanceof PDFRawStream ? decodePDFRawStream(stream).decode() : stream.getContents()).toString(
        "latin1"
      )
    )
    .join("\n");
  const cleaned = source.replace(/(^|\s)BT\s[\s\S]*?\sET(?=\s|$)/g, "$1");
  page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.flateStream(Buffer.from(cleaned, "latin1"))));
}

function textBlocks(items) {
  const columns = [];
  for (const item of [...items].sort((a, b) => a.x - b.x)) {
    const column = columns.find((c) => Math.abs(c.x - item.x) <= 3);
    if (column) column.items.push(item);
    else columns.push({ x: item.x, items: [item] });
  }
  const blocks = [];
  for (const column of columns) {
    const sorted = column.items.sort((a, b) => b.y - a.y);
    let block = null;
    for (const item of sorted) {
      if (block && block.bottom - item.y <= item.h * 2.2) {
        block.items.push(item);
        block.bottom = item.y;
      } else {
        block = { x: column.x, top: item.y + item.h, bottom: item.y, items: [item] };
        blocks.push(block);
      }
    }
  }
  return blocks;
}

function trackedWidth(text, font, size, tracking) {
  return font.widthOfTextAtSize(text, size) + tracking * (text.length - 1);
}

function drawTracked(page, text, { x, y, size, font, color, tracking }) {
  let cursor = x;
  for (const ch of text) {
    page.drawText(ch, { x: cursor, y, size, font, color });
    cursor += font.widthOfTextAtSize(ch, size) + tracking;
  }
}

/**
 * Builds the pack cover from the broker's front cover: the artwork stays, its own words are
 * removed, and the pack title and details are set where the cover's title and text blocks were.
 * Returns false when the cover has no live text to replace, so the caller can draw a plain cover.
 */
export async function addBrandedCover(out, frontAsset, { font, bold, theme }, content) {
  if (!frontAsset) return false;
  const isPdf = (frontAsset.mime || "").includes("pdf") || frontAsset.storage_ref.endsWith(".pdf");
  if (!isPdf) return false;
  const bytes = readBytes(frontAsset.storage_ref);
  const [first] = await extractTextItems(bytes);
  const items = first?.items || [];
  if (!items.length) return false;

  const tallest = Math.max(...items.map((item) => item.h));
  const titleItems = items.filter((item) => item.h >= tallest * 0.6);
  const centre = (item) => item.x + item.w / 2;
  for (let grew = true; grew; ) {
    grew = false;
    const middle = titleItems.reduce((sum, item) => sum + centre(item), 0) / titleItems.length;
    const low = Math.min(...titleItems.map((item) => item.y));
    const high = Math.max(...titleItems.map((item) => item.y + item.h));
    for (const item of items) {
      if (titleItems.includes(item) || item.h < tallest * 0.2 || Math.abs(centre(item) - middle) > 30) continue;
      if (low - (item.y + item.h) <= tallest * 0.8 && item.y - high <= tallest * 0.8) {
        titleItems.push(item);
        grew = true;
      }
    }
  }
  const titleLeft = Math.min(...titleItems.map((item) => item.x));
  const titleRight = Math.max(...titleItems.map((item) => item.x + item.w));
  const titleBottom = Math.min(...titleItems.map((item) => item.y));
  const titleTop = Math.max(...titleItems.map((item) => item.y + item.h));
  const centerX = (titleLeft + titleRight) / 2;
  const centerY = (titleBottom + titleTop) / 2;

  const blocks = textBlocks(items.filter((item) => !titleItems.includes(item))).sort((a, b) => b.top - a.top);
  const heading = blocks[0];
  const lower = heading ? blocks.slice(1).filter((block) => block.top < heading.bottom).sort((a, b) => a.x - b.x) : [];
  if (!heading || !lower.length || heading.top > titleBottom) return false;

  const src = await PDFDocument.load(bytes);
  stripPageText(src, src.getPage(0));
  const stripped = await src.save();
  const [after] = await extractTextItems(stripped);
  if (after?.items?.length) return false;
  const [page] = await out.copyPages(await PDFDocument.load(stripped), [0]);
  out.addPage(page);
  const { width } = page.getSize();
  const white = rgb(1, 1, 1);

  const unit = trackedWidth(content.title, bold, 1, 0.08);
  const titleSize = Math.min(tallest * 0.85, (width * 0.74) / unit);
  const subSize = titleSize * 0.3;
  const titleTracking = titleSize * 0.08;
  const subTracking = subSize * 0.12;
  const blockH = titleSize * 0.72 + titleSize * 0.28 + subSize * 0.72;
  const titleBase = centerY + blockH / 2 - titleSize * 0.72;
  drawTracked(page, content.title, {
    x: centerX - trackedWidth(content.title, bold, titleSize, titleTracking) / 2,
    y: titleBase,
    size: titleSize,
    font: bold,
    color: white,
    tracking: titleTracking,
  });
  drawTracked(page, content.subtitle, {
    x: centerX - trackedWidth(content.subtitle, bold, subSize, subTracking) / 2,
    y: titleBase - titleSize * 0.28 - subSize * 0.72,
    size: subSize,
    font: bold,
    color: white,
    tracking: subTracking,
  });

  const legal = lower[0];
  const meta = lower.find((block) => block !== legal && block.x > (legal?.x ?? 0));
  const right = width - 28;

  const slots = heading.items.map((item) => item.y);
  const step = slots.length > 1 ? slots[0] - slots[1] : 18;
  const headingLines = [
    { text: content.brand, size: 12.5, font: bold, color: theme.ink },
    { text: content.packTitle, size: 11.5, font: bold, color: theme.accent },
    { text: content.forUse, size: 7.5, font, color: theme.muted },
  ];
  let cursor = null;
  headingLines.forEach((line, index) => {
    const rows = wrapText(line.text, line.font, line.size, right - heading.x);
    let base = slots[index] ?? cursor - step;
    if (cursor != null && base > cursor - (line.size + 4)) base = cursor - (line.size + 4);
    rows.forEach((row, n) => {
      page.drawText(row, { x: heading.x, y: base - n * (line.size + 2), size: line.size, font: line.font, color: line.color });
    });
    cursor = base - (rows.length - 1) * (line.size + 2);
  });
  const headingBottom = cursor;

  const facts = [...content.parties];
  if (!meta) facts.push(...content.meta);
  const lowerTop = legal ? legal.top : null;
  let factY = lowerTop == null ? headingBottom - 22 : headingBottom - Math.max(20, (headingBottom - lowerTop) * 0.36);
  for (const [label, value] of facts) {
    const labelText = packText(`${label}: `);
    page.drawText(labelText, { x: heading.x, y: factY, size: 8.5, font: bold, color: theme.ink });
    const rest = wrapText(value, font, 8.5, right - heading.x - bold.widthOfTextAtSize(labelText, 8.5))[0] || "";
    page.drawText(rest, {
      x: heading.x + bold.widthOfTextAtSize(labelText, 8.5),
      y: factY,
      size: 8.5,
      font,
      color: theme.ink,
    });
    factY -= 12.5;
  }

  if (legal) {
    const legalRight = meta ? meta.x - 12 : right;
    let ly = legal.items[0].y;
    page.drawText(packText(content.legal[0]), { x: legal.x, y: ly, size: 9, font: bold, color: theme.ink });
    ly -= 10.5;
    for (const line of content.legal.slice(1)) {
      for (const row of wrapText(line, font, 7.5, legalRight - legal.x)) {
        page.drawText(row, { x: legal.x, y: ly, size: 7.5, font, color: theme.muted });
        ly -= 9.5;
      }
    }
  }
  if (meta) {
    const metaSlots = meta.items.map((item) => item.y);
    content.meta.forEach(([label, value], index) => {
      const my = metaSlots[index] ?? metaSlots[metaSlots.length - 1] - (index - metaSlots.length + 1) * 36;
      page.drawText(packText(`${label}:`), { x: meta.x, y: my, size: 8, font: bold, color: theme.ink });
      page.drawText(packText(value), { x: meta.x, y: my - 11, size: 8, font, color: theme.muted });
    });
  }
  return true;
}

/** Generated cover for brokers whose front cover has no details panel to fill. */
export function addPlainCover(out, { font, bold, theme }, content, logo) {
  const page = out.addPage([PAGE.w, PAGE.h]);
  if (logo) {
    const h = 56;
    const w = (logo.width / logo.height) * h;
    page.drawImage(logo, { x: (PAGE.w - w) / 2, y: 728, width: w, height: h });
  }

  const bandTop = 650;
  const bandBottom = 480;
  page.drawRectangle({ x: 0, y: bandBottom, width: PAGE.w, height: bandTop - bandBottom, color: theme.accent });
  const titleSize = Math.min(54, (PAGE.w * 0.74) / trackedWidth(content.title, bold, 1, 0.08));
  const subSize = titleSize * 0.3;
  const titleTracking = titleSize * 0.08;
  const subTracking = subSize * 0.12;
  const blockH = titleSize * 0.72 + titleSize * 0.28 + subSize * 0.72;
  const titleBase = (bandTop + bandBottom) / 2 + blockH / 2 - titleSize * 0.72;
  const white = rgb(1, 1, 1);
  drawTracked(page, content.title, {
    x: (PAGE.w - trackedWidth(content.title, bold, titleSize, titleTracking)) / 2,
    y: titleBase,
    size: titleSize,
    font: bold,
    color: white,
    tracking: titleTracking,
  });
  drawTracked(page, content.subtitle, {
    x: (PAGE.w - trackedWidth(content.subtitle, bold, subSize, subTracking)) / 2,
    y: titleBase - titleSize * 0.28 - subSize * 0.72,
    size: subSize,
    font: bold,
    color: white,
    tracking: subTracking,
  });

  let y = 436;
  const line = (text, size, face, color, gap) => {
    for (const row of wrapText(text, face, size, CONTENT_W)) {
      page.drawText(row, { x: MARGIN, y, size, font: face, color });
      y -= size + gap;
    }
  };
  line(content.brand, 14, bold, theme.ink, 8);
  line(content.packTitle, 13, bold, theme.accent, 10);
  line(content.forUse, 9, font, theme.muted, 14);
  page.drawRectangle({ x: MARGIN, y: y + 4, width: 80, height: 3, color: theme.accent });
  y -= 18;
  for (const [label, value] of content.parties) {
    const labelText = packText(`${label}: `);
    const labelW = bold.widthOfTextAtSize(labelText, 10);
    page.drawText(labelText, { x: MARGIN, y, size: 10, font: bold, color: theme.ink });
    page.drawText(wrapText(value, font, 10, CONTENT_W - labelW)[0] || "", { x: MARGIN + labelW, y, size: 10, font, color: theme.ink });
    y -= 15;
  }

  const metaX = PAGE.w - MARGIN - 120;
  page.drawRectangle({ x: metaX - 14, y: 70, width: 1.5, height: 92, color: theme.rule });
  let ly = 150;
  page.drawText(packText(content.legal[0]), { x: MARGIN, y: ly, size: 10, font: bold, color: theme.ink });
  ly -= 12.5;
  for (const text of content.legal.slice(1)) {
    for (const row of wrapText(text, font, 8, metaX - 28 - MARGIN)) {
      page.drawText(row, { x: MARGIN, y: ly, size: 8, font, color: theme.muted });
      ly -= 10.5;
    }
  }
  content.meta.forEach(([label, value], index) => {
    const my = 150 - index * 36;
    page.drawText(packText(`${label}:`), { x: metaX, y: my, size: 8.5, font: bold, color: theme.ink });
    page.drawText(packText(value), { x: metaX, y: my - 12, size: 8.5, font, color: theme.muted });
  });
}

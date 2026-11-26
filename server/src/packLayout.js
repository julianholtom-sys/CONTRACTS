import {
  LineCapStyle,
  PDFArray,
  PDFDocument,
  PDFEmbeddedPage,
  PDFName,
  PDFRawStream,
  PDFTextField,
  decodePDFRawStream,
  degrees,
  rgb,
  setCharacterSpacing,
} from "pdf-lib";
import { extractTextItems } from "./detectFields.js";
import { readBytes } from "./storage.js";

export const PAGE = { w: 595.28, h: 841.89 };
export const MARGIN = 56;
export const CONTENT_W = PAGE.w - MARGIN * 2;
export const BODY_TOP = 752;
export const BODY_BOTTOM = 64;

const WIN_ANSI_EXTRA = "‘’‚“”„–—•…€™‹›ŠšŒœŽžŸ†‡‰ƒ";

/** Standard PDF fonts draw WinAnsi only; anything else becomes a space. Apostrophes are always curly. */
export function packText(value) {
  const curly = String(value ?? "")
    .replace(/(^|[\s([{“"])'/g, "$1‘")
    .replace(/['`\u2032]/g, "’");
  return Array.from(curly)
    .map((ch) => {
      const code = ch.codePointAt(0);
      if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || WIN_ANSI_EXTRA.includes(ch)) return ch;
      return " ";
    })
    .join("");
}

/** Wraps a comma-separated value (an address) at its commas, so a line never breaks inside a part. */
export function wrapAtCommas(text, font, size, width) {
  const lines = [];
  let current = "";
  for (const part of String(text ?? "").split(/,\s*/).filter(Boolean)) {
    const next = current ? `${current}, ${part}` : part;
    if (!current || font.widthOfTextAtSize(packText(`${next},`), size) <= width) {
      current = next;
      continue;
    }
    lines.push(`${current},`);
    current = part;
  }
  if (current) lines.push(current);
  return lines.flatMap((line) => wrapText(line, font, size, width));
}

/** "UNION WORK SERVICES LIMITED (trading as Union Payroll)", the broker as one legal entity. */
export function brokerLegalName(entity) {
  const legal = String(entity?.legal_name || "").trim();
  const trading = String(entity?.display_name || "").trim();
  if (!legal) return trading;
  const bare = (name) => name.toUpperCase().replace(/[^A-Z0-9 ]/g, "").replace(/\s+(LIMITED|LTD|PLC|LLP)$/, "").trim();
  if (/trading as/i.test(legal) || !trading || bare(trading) === bare(legal)) return legal;
  return `${legal} (trading as ${trading})`;
}

const SMALL_WORDS = new Set(["and", "of", "the", "for", "to", "in", "on", "at", "by"]);
const KEEP_UPPER = new Set(["UK", "LLP", "PLC", "CIC", "LP", "UAE", "USA", "EU"]);

/** "ARC RISK MODELS LIMITED" as "Arc Risk Models Limited", for second and later mentions. */
export function normalCase(name) {
  return String(name || "")
    .replace(/\s*\(trading as [^)]*\)\s*$/i, "")
    .split(/\s+/)
    .filter(Boolean)
    .map((word, index) => {
      if (/\d/.test(word) || KEEP_UPPER.has(word.replace(/[^A-Z]/g, ""))) return word;
      const lower = word.toLowerCase();
      if (index > 0 && SMALL_WORDS.has(lower)) return lower;
      return lower.replace(/(^|[-'’(&])([a-z])/g, (_, lead, letter) => lead + letter.toUpperCase());
    })
    .join(" ");
}

export function wrapText(text, font, size, width) {
  const lines = [];
  for (const paragraph of String(text ?? "").split("\n")) {
    let current = "";
    for (const word of packText(paragraph).split(/[^\S\u00a0]+/).filter(Boolean)) {
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
    alert: rgb(0.8, 0.1, 0.1),
    ok: rgb(0.05, 0.6, 0.25),
  };
}

/** "UNION PAYROLL" style: first word bold, the rest regular. A one-letter first word ("E STREET") stays with the next. */
export function wordmarkParts(name) {
  const words = String(name || "").toUpperCase().split(/\s+/).filter(Boolean);
  const lead = words.length > 2 && words[0].length === 1 ? 2 : 1;
  return words.length > lead ? [words.slice(0, lead).join(" "), words.slice(lead).join(" ")] : [words.join(" ")].filter(Boolean);
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
   * Bordered table. Columns are { label, width, align? } with widths summing to the content width.
   * A cell is a string, { text, bold, color }, { runs: [{ text, bold, color }] } for mixed styling
   * on one line, or { result: "clear" | "flag" | "na", label? } for a check result.
   */
  tableLayout(columns, { labelColumn = false, size = 8.5 } = {}) {
    const pad = 5;
    const lineH = size + 3;
    const faceFor = (cell, index, isHeader) =>
      isHeader || (typeof cell === "object" && cell?.bold) || (labelColumn && index === 0) ? this.bold : this.font;
    const cellText = (cell) =>
      cell && typeof cell === "object" ? (cell.runs ? cell.runs.map((run) => run.text).join("") : cell.text) : cell ?? "";
    const runsFit = (cell, index) =>
      Boolean(cell?.runs) &&
      cell.runs.reduce((w, run) => w + this.bold.widthOfTextAtSize(packText(run.text), size), 0) <= columns[index].width - pad * 2;
    const layout = (cells, isHeader) => {
      const lines = cells.map((cell, index) =>
        cell && typeof cell === "object" && "result" in cell
          ? [""]
          : runsFit(cell, index)
            ? [cellText(cell)]
            : wrapText(cellText(cell), faceFor(cell, index, isHeader), size, columns[index].width - pad * 2)
      );
      return { lines, height: Math.max(...lines.map((l) => l.length)) * lineH + pad * 2 - 2 };
    };
    return { pad, lineH, faceFor, runsFit, layout };
  }

  /** Height a table takes, including the gap after it, so a short table can be kept on one page. */
  tableHeight(columns, rows, { header = true, ...options } = {}) {
    const { layout } = this.tableLayout(columns, options);
    const headerHeight = header ? layout(columns.map((column) => column.label), true).height : 0;
    return headerHeight + rows.reduce((sum, row) => sum + layout(row, false).height, 0) + 12;
  }

  table(columns, rows, { header = true, labelColumn = false, size = 8.5 } = {}) {
    const xs = [];
    columns.reduce((x, column) => {
      xs.push(x);
      return x + column.width;
    }, MARGIN);
    const { pad, lineH, faceFor, runsFit, layout } = this.tableLayout(columns, { labelColumn, size });
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
        if (cell && typeof cell === "object" && "result" in cell) {
          this.resultMark(xs[index] + columns[index].width / 2, top - pad - size + 1, cell.result, size, cell.label);
          return;
        }
        const color = (typeof cell === "object" && cell?.color) || this.theme.ink;
        const face = faceFor(cell, index, isHeader);
        if (runsFit(cell, index)) {
          let x = xs[index] + pad;
          for (const run of cell.runs) {
            const runFace = run.bold ? this.bold : face;
            this.draw(run.text, x, top - pad - size + 1, { size, font: runFace, color: run.color || color });
            x += runFace.widthOfTextAtSize(packText(run.text), size);
          }
          return;
        }
        lines[index].forEach((line, n) => {
          const x =
            columns[index].align === "center"
              ? xs[index] + (columns[index].width - face.widthOfTextAtSize(packText(line), size)) / 2
              : xs[index] + pad;
          this.draw(line, x, top - pad - size + 1 - n * lineH, { size, font: face, color });
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

  /**
   * "Clear" with a green tick, "Flag" with a red cross, or a grey "N/A", centred on cx at the text baseline.
   * `label` replaces the word (e.g. "Verified" with the tick), keeping the mark and colour.
   */
  resultMark(cx, baseline, result, size, label) {
    const word = label || (result === "clear" ? "Clear" : result === "flag" ? "Flag" : "N/A");
    const color = result === "clear" ? this.theme.ok : result === "flag" ? this.theme.alert : this.theme.muted;
    const markW = result === "na" ? 0 : size * 0.95;
    const gap = markW ? size * 0.45 : 0;
    const left = cx - (markW + gap + this.bold.widthOfTextAtSize(word, size)) / 2;
    const mid = baseline + size * 0.36;
    const unit = size * 1.05;
    const line = (x1, y1, x2, y2) =>
      this.page.drawLine({
        start: { x: left + markW / 2 + x1 * unit, y: mid + y1 * unit },
        end: { x: left + markW / 2 + x2 * unit, y: mid + y2 * unit },
        thickness: unit * 0.17,
        color,
        lineCap: LineCapStyle.Round,
      });
    if (result === "clear") {
      line(-0.4, 0.02, -0.12, -0.28);
      line(-0.12, -0.28, 0.42, 0.34);
    } else if (result === "flag") {
      line(-0.3, -0.3, 0.3, 0.3);
      line(-0.3, 0.3, 0.3, -0.3);
    }
    this.draw(word, left + markW + gap, baseline, { size, font: this.bold, color });
  }

  /** A short "Label: value" line in body text, used for sign-off lines under a table. */
  labelLine(pairs, { size = 8.5, gap = 18 } = {}) {
    this.ensure(size + 6);
    let x = MARGIN;
    for (const [label, value] of pairs) {
      const labelText = `${label}: `;
      this.draw(labelText, x, this.y - size, { size, font: this.bold });
      x += this.bold.widthOfTextAtSize(packText(labelText), size);
      this.draw(value, x, this.y - size, { size, color: this.theme.ink });
      x += this.font.widthOfTextAtSize(packText(value), size) + gap;
    }
    this.y -= size + 14;
  }
}

/** Caption at the top of an annex page; later pages of the same document say "(continued)". */
export function drawCaption(page, { font, bold, theme }, caption, continued = false) {
  if (continued) {
    const line = wrapText(`${caption} (continued)`, font, 8, CONTENT_W)[0];
    page.drawText(line, { x: MARGIN, y: BODY_TOP - 9, size: 8, font, color: theme.muted });
    return;
  }
  const line = wrapText(caption, bold, 9.5, CONTENT_W)[0];
  page.drawText(line, { x: MARGIN, y: BODY_TOP - 10, size: 9.5, font: bold, color: theme.ink });
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

const NUM = "[-+]?(?:\\d+\\.?\\d*|\\.\\d+)";
const MATRIX = `((?:${NUM}\\s+){6})`;
const STRING = "\\((?:\\\\[\\s\\S]|[^()\\\\])*\\)|<[0-9A-Fa-f\\s]*>";
const SHOW_TEXT = new RegExp(
  `\\[(?:${STRING}|[^\\]()<>])*\\]\\s*TJ|(?:${STRING})\\s*(?:Tj|')|${NUM}\\s+${NUM}\\s+(?:${STRING})\\s*"`,
  "g",
);
const CONTENT_TOKEN = new RegExp(
  `(^|\\s)BI\\s[\\s\\S]*?\\sID\\s[\\s\\S]*?\\sEI(?=\\s|$)|(^|\\s)BT\\s([\\s\\S]*?)\\sET(?=\\s|$)|(?:^|\\s)(q|Q)(?=\\s|$)|${MATRIX}cm(?=\\s|$)`,
  "g",
);
const IDENTITY = [1, 0, 0, 1, 0, 0];

function multiply(m, c) {
  return [
    m[0] * c[0] + m[1] * c[2],
    m[0] * c[1] + m[1] * c[3],
    m[2] * c[0] + m[3] * c[2],
    m[2] * c[1] + m[3] * c[3],
    m[4] * c[0] + m[5] * c[2] + c[4],
    m[4] * c[1] + m[5] * c[3] + c[5],
  ];
}

const numbers = (text) => text.trim().split(/\s+/).map(Number);

/**
 * Removes the words from a page and leaves its artwork. Each text object is located by its
 * first text matrix; `keep(x, y)` keeps the ones that should stay, and `fix(body)` may correct
 * a kept one. Font and spacing operators are left in place so kept text draws with the state it expects.
 */
function stripPageText(doc, page, keep = () => false, fix = (body) => body) {
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
  let ctm = IDENTITY;
  const saved = [];
  const cleaned = source.replace(CONTENT_TOKEN, (match, imageLead, lead, body, state, cm) => {
    if (state === "q") saved.push(ctm);
    else if (state === "Q") ctm = saved.pop() || IDENTITY;
    else if (cm) ctm = multiply(numbers(cm), ctm);
    if (body == null) return match;
    const tm = body.match(new RegExp(`${MATRIX}Tm`));
    const td = body.match(new RegExp(`(${NUM})\\s+(${NUM})\\s+T[dD]`));
    const [x, y] = tm ? numbers(tm[1]).slice(4) : td ? [Number(td[1]), Number(td[2])] : [0, 0];
    const at = multiply([1, 0, 0, 1, x, y], ctm);
    if (keep(at[4], at[5])) return `${lead}BT ${fix(body)} ET`;
    return `${lead}BT ${body.replace(SHOW_TEXT, " ")} ET`;
  });
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

const CAP_HEIGHT = 0.718;
const lineLead = (size) => (size >= 18 ? 1.03 : size >= 10 ? 1.58 : 1.45);

/** One text run with character spacing, so the words still copy as words. */
function drawSpaced(page, text, { tracking = 0, ...options }) {
  if (tracking) page.pushOperators(setCharacterSpacing(tracking));
  page.drawText(text, options);
  if (tracking) page.pushOperators(setCharacterSpacing(0));
}

/**
 * "[Reference]" style placeholders replaced from `tokens`. A " · " part whose placeholder
 * has no value is dropped, so "Ref. [Reference] · Prepared [Prepared]" never ends "Prepared ".
 */
function fillTokens(text, tokens) {
  return String(text ?? "")
    .split("\n")
    .map((line) => {
      const parts = line.split(" · ");
      return parts
        .map((part) => {
          let missing = false;
          const filled = part.replace(/\[([^\]]+)\]/g, (_, key) => {
            const value = String(tokens[key] ?? "").trim();
            if (!value) missing = true;
            return value;
          });
          return missing && parts.length > 1 ? "" : filled;
        })
        .filter((part) => part.trim())
        .join(" · ")
        .replace(/\s{2,}/g, " ")
        .trim();
    })
    .join("\n");
}

function fieldStyle(field, { font, bold, theme }) {
  const da = field.acroField.getDefaultAppearance() || "";
  const tf = da.match(/\/(\S+)\s+([\d.]+)\s+Tf/);
  const tc = da.match(/(-?[\d.]+)\s+Tc/);
  const colour = da.match(/([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg/) || da.match(/([\d.]+)\s+g\b/);
  const widget = field.acroField.getWidgets()[0];
  const border = widget.getAppearanceCharacteristics()?.getBorderColor();
  const size = Number(tf?.[2]) || 9;
  return {
    font: /bold/i.test(tf?.[1] || "") ? bold : font,
    size,
    spacing: (Number(tc?.[1]) || 0) / size,
    color: colour ? rgb(Number(colour[1]), Number(colour[2] ?? colour[1]), Number(colour[3] ?? colour[1])) : theme.ink,
    rule: border?.length === 3 ? rgb(...border) : theme.rule,
    align: field.acroField.getQuadding() ?? 0,
    multiline: field.isMultiline(),
    rect: widget.getRectangle(),
  };
}

function drawFieldText(page, text, template, style) {
  const { rect, font, color, align } = style;
  const value = packText(text);
  const tracking = (size) => size * style.spacing;
  const widthAt = (line, size) => trackedWidth(line, font, size, tracking(size));
  const xFor = (line, size) =>
    align === 2 ? rect.x + rect.width - widthAt(line, size) : align === 1 ? rect.x + (rect.width - widthAt(line, size)) / 2 : rect.x;
  const draw = (line, size, y) => drawSpaced(page, line, { x: xFor(line, size), y, size, font, color, tracking: tracking(size) });

  if (!style.multiline) {
    let size = style.size;
    const full = widthAt(value, size);
    if (full > rect.width) size = Math.max(style.size * 0.6, (size * rect.width) / full);
    let line = value;
    while (line.length > 1 && widthAt(line, size) > rect.width) line = `${line.slice(0, -2).trimEnd()}…`;
    draw(line, size, rect.y + (rect.height - size * CAP_HEIGHT) / 2);
    return;
  }
  const factor = lineLead(style.size);
  const address = template.trim() === "[Registered office]";
  let size = style.size;
  let lines;
  for (;;) {
    lines = address ? wrapAtCommas(value, font, size, rect.width) : wrapText(value, font, size, rect.width);
    if (lines.length * size * factor <= rect.height + 0.5 || size <= style.size * 0.6) break;
    size *= 0.95;
  }
  const step = size * factor;
  const top = rect.y + rect.height;
  lines.forEach((line, index) => draw(packText(line), size, top - (step + size * CAP_HEIGHT) / 2 - index * step));
}

/** The parties table: one row per [label, value, accent], labels small and spaced, a rule above and below each row. */
function drawFieldRows(page, rows, style, { bold, theme }) {
  const { rect, size } = style;
  const pitch = rect.height / Math.max(6, rows.length);
  const valueX = rect.x + rect.width * 0.32;
  const valueW = rect.x + rect.width - valueX;
  const labelSize = size * 0.72;
  const rule = (y) => page.drawRectangle({ x: rect.x, y: y - 0.375, width: rect.width, height: 0.75, color: style.rule });
  let top = rect.y + rect.height;
  rule(top);
  for (const [label, value, accent] of rows) {
    const base = top - pitch * 0.556;
    drawSpaced(page, packText(String(label).toUpperCase()), {
      x: rect.x + 0.4,
      y: base,
      size: labelSize,
      font: bold,
      color: theme.muted,
      tracking: labelSize * 0.12,
    });
    const color = accent ? theme.accent : style.color;
    const text = packText(value || "—");
    let valueSize = size;
    const full = style.font.widthOfTextAtSize(text, size);
    if (full > valueW) valueSize = Math.max(size * 0.78, (size * valueW) / full);
    let lines = [text];
    if (style.font.widthOfTextAtSize(text, valueSize) > valueW) {
      lines = wrapText(text, style.font, valueSize, valueW);
      while (lines.length > 2 && valueSize > size * 0.6) {
        valueSize -= 0.2;
        lines = wrapText(text, style.font, valueSize, valueW);
      }
      if (lines.length > 2) lines = [lines[0], `${lines[1]}…`];
    }
    const gap = valueSize * 1.2;
    lines.forEach((line, index) => {
      page.drawText(line, {
        x: valueX,
        y: base + ((lines.length - 1) / 2 - index) * gap,
        size: valueSize,
        font: style.font,
        color,
      });
    });
    top -= pitch;
    rule(top);
  }
}

/**
 * A cover drawn as a template: named text fields mark where the contract's values go and the
 * rest of the page is kept as it is. A field's own text may hold placeholders ("[Reference]");
 * `fill.fields` replaces a field's text outright, and the `parties` field becomes a table of
 * `fill.rows`. The fields are removed, so the result is a flat page. Returns the number of
 * pages added (the first page only for a front cover), or 0 when the cover has no fields.
 */
async function addTemplateCover(out, bytes, fonts, fill = {}, { allPages = false } = {}) {
  const src = await PDFDocument.load(bytes);
  const fields = src.getForm().getFields().filter((field) => field instanceof PDFTextField);
  if (!fields.length) return 0;
  const pages = src.getPages();
  const indices = allPages ? src.getPageIndices() : [0];
  const widgetRefs = new Set();
  const placed = fields.map((field) => {
    const [ref, ...more] = field.acroField.getWidgets().map((widget) => src.context.getObjectRef(widget.dict));
    [ref, ...more].forEach((item) => widgetRefs.add(item));
    const pageIndex = pages.findIndex((page) => (page.node.Annots()?.asArray() || []).some((item) => item === ref));
    return { name: field.getName(), template: field.getText() || "", style: fieldStyle(field, fonts), pageIndex };
  });
  for (const page of pages) {
    const annots = page.node.Annots();
    if (!annots) continue;
    const kept = annots.asArray().filter((item) => !widgetRefs.has(item));
    if (kept.length) page.node.set(PDFName.of("Annots"), src.context.obj(kept));
    else page.node.delete(PDFName.of("Annots"));
  }
  src.catalog.delete(PDFName.of("AcroForm"));
  const copies = await out.copyPages(src, indices);
  copies.forEach((page) => out.addPage(page));

  for (const item of placed) {
    const at = indices.indexOf(item.pageIndex);
    if (at < 0) continue;
    if (item.name === "parties" && fill.rows?.length) {
      drawFieldRows(copies[at], fill.rows, item.style, fonts);
      continue;
    }
    const text = fillTokens(fill.fields?.[item.name] ?? item.template, fill.tokens || {});
    if (text) drawFieldText(copies[at], text, item.template, item.style);
  }
  return copies.length;
}

/**
 * Builds a cover from the broker's front cover: the artwork stays, its own words are removed,
 * and the details are set where the cover's text blocks were. With no `content.title` the
 * cover's own title is kept. A cover with named fields is filled from `content.fill` instead
 * (see addTemplateCover). Returns false when the cover has no details panel to fill.
 */
export async function addBrandedCover(out, frontAsset, { font, bold, theme }, content) {
  if (!frontAsset) return false;
  const isPdf = (frontAsset.mime || "").includes("pdf") || frontAsset.storage_ref.endsWith(".pdf");
  if (!isPdf) return false;
  const bytes = readBytes(frontAsset.storage_ref);
  if (await addTemplateCover(out, bytes, { font, bold, theme }, content.fill)) return true;
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

  const keepTitle = !content.title;
  const isTitle = (x, y) => titleItems.some((item) => Math.abs(item.x - x) < 1.5 && Math.abs(item.y - y) < 1.5);
  const src = await PDFDocument.load(bytes);
  stripPageText(src, src.getPage(0), keepTitle ? isTitle : undefined);
  const stripped = await src.save();
  const [after] = await extractTextItems(stripped);
  const remaining = after?.items || [];
  if (remaining.length !== (keepTitle ? titleItems.length : 0)) return false;
  if (!remaining.every((item) => isTitle(item.x, item.y))) return false;
  const [page] = await out.copyPages(await PDFDocument.load(stripped), [0]);
  out.addPage(page);
  const { width } = page.getSize();

  if (!keepTitle) {
    const white = rgb(1, 1, 1);
    const unit = trackedWidth(content.title, bold, 1, 0.08);
    const titleSize = Math.min(tallest * 0.85, (width * 0.74) / unit);
    const subSize = content.subtitle ? titleSize * 0.3 : 0;
    const titleTracking = titleSize * 0.08;
    const subTracking = subSize * 0.12;
    const blockH = titleSize * 0.72 + (subSize ? titleSize * 0.28 + subSize * 0.72 : 0);
    const titleBase = centerY + blockH / 2 - titleSize * 0.72;
    const padY = titleSize * 0.55;
    page.drawRectangle({
      x: 0,
      y: centerY - blockH / 2 - padY,
      width,
      height: blockH + padY * 2,
      color: rgb(0.02, 0.05, 0.1),
      opacity: 0.55,
    });
    drawTracked(page, content.title, {
      x: centerX - trackedWidth(content.title, bold, titleSize, titleTracking) / 2,
      y: titleBase,
      size: titleSize,
      font: bold,
      color: white,
      tracking: titleTracking,
    });
    if (content.subtitle) {
      drawTracked(page, content.subtitle, {
        x: centerX - trackedWidth(content.subtitle, bold, subSize, subTracking) / 2,
        y: titleBase - titleSize * 0.28 - subSize * 0.72,
        size: subSize,
        font: bold,
        color: white,
        tracking: subTracking,
      });
    }
  }

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
    for (const row of wrapText(content.legal[0], bold, 9, legalRight - legal.x)) {
      page.drawText(row, { x: legal.x, y: ly, size: 9, font: bold, color: theme.ink });
      ly -= 10.5;
    }
    for (const line of content.legal.slice(1)) {
      for (const row of wrapAtCommas(line, font, 7.5, legalRight - legal.x)) {
        page.drawText(packText(row), { x: legal.x, y: ly, size: 7.5, font, color: theme.muted });
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
  const subSize = content.subtitle ? titleSize * 0.3 : 0;
  const titleTracking = titleSize * 0.08;
  const subTracking = subSize * 0.12;
  const blockH = titleSize * 0.72 + (subSize ? titleSize * 0.28 + subSize * 0.72 : 0);
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
  if (content.subtitle) {
    drawTracked(page, content.subtitle, {
      x: (PAGE.w - trackedWidth(content.subtitle, bold, subSize, subTracking)) / 2,
      y: titleBase - titleSize * 0.28 - subSize * 0.72,
      size: subSize,
      font: bold,
      color: white,
      tracking: subTracking,
    });
  }

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
  for (const row of wrapText(content.legal[0], bold, 10, metaX - 28 - MARGIN)) {
    page.drawText(row, { x: MARGIN, y: ly, size: 10, font: bold, color: theme.ink });
    ly -= 12.5;
  }
  for (const text of content.legal.slice(1)) {
    for (const row of wrapAtCommas(text, font, 8, metaX - 28 - MARGIN)) {
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

const PHONE = /(\+?\d[\d ]{7,}\d)/;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
const WEBSITE = /website\s*:?\s*((?:https?:\/\/)?[\w-]+(?:\.[\w-]+)+[\w./-]*)/i;

/** The back cover's small text: a company heading, a row of column headers, and values under them. */
function contactLayout(items) {
  if (!items.length) return null;
  const tallest = Math.max(...items.map((item) => item.h));
  const banner = items.filter((item) => item.h >= Math.max(14, tallest * 0.4));
  const small = items.filter((item) => !banner.includes(item));
  if (!small.length) return null;
  const headingSize = Math.max(...small.map((item) => item.h));
  const heading = small.filter((item) => item.h === headingSize).sort((a, b) => b.y - a.y)[0];
  const below = small.filter((item) => item.y < heading.y - 1);
  if (!below.length) return null;
  const headerSize = Math.max(...below.map((item) => item.h));
  const headerY = Math.max(...below.filter((item) => item.h === headerSize).map((item) => item.y));
  const headers = below
    .filter((item) => item.h === headerSize && Math.abs(item.y - headerY) < 1.5)
    .sort((a, b) => a.x - b.x);
  const values = below.filter((item) => item.y < headerY - 1);
  if (headers.length < 2 || !values.length) return null;
  const text = small.map((item) => item.str).join(" ");
  return {
    banner,
    heading,
    headers,
    headerY,
    valueTop: Math.max(...values.map((item) => item.y)),
    valueSize: Math.max(...values.map((item) => item.h)),
    phone: (text.match(PHONE) || [])[1] || "",
    email: (text.match(EMAIL) || [])[0] || "",
    website: (text.match(WEBSITE) || [])[1] || "",
  };
}

function drawContactBlock(page, layout, legal, { font, bold, theme }) {
  const right = page.getSize().width - 28;
  const { heading, headers, headerY, valueTop, valueSize: size } = layout;
  wrapText(legal.name, bold, heading.h, right - heading.x).forEach((row, n) => {
    page.drawText(row, { x: heading.x, y: heading.y - n * (heading.h + 3), size: heading.h, font: bold, color: theme.ink });
  });
  const columns = [
    {
      title: "Registered office:",
      lines: [
        ...(legal.registeredOffice ? [{ text: legal.registeredOffice, commas: true }] : []),
        ...(legal.companyNumber ? [{ text: `Company number ${legal.companyNumber}` }] : []),
      ],
    },
    layout.phone ? { title: "Phone:", lines: [{ text: layout.phone }] } : null,
    layout.email || layout.website
      ? {
          title: "Online:",
          lines: [
            ...(layout.email ? [{ label: "Email", text: layout.email }] : []),
            ...(layout.website ? [{ label: "Website", text: layout.website }] : []),
          ],
        }
      : null,
  ].filter(Boolean);
  columns.slice(0, headers.length).forEach((column, index) => {
    const x = headers[index].x;
    const columnW = (headers[index + 1]?.x ?? right) - x - 16;
    page.drawText(packText(column.title), { x, y: headerY, size: headers[index].h, font, color: theme.ink });
    let y = valueTop;
    for (const line of column.lines) {
      const labelText = line.label ? packText(`${line.label}: `) : "";
      const labelW = labelText ? font.widthOfTextAtSize(labelText, size) : 0;
      const rows = line.commas ? wrapAtCommas(line.text, font, size, columnW) : wrapText(line.text, font, size, columnW - labelW);
      rows.forEach((row, n) => {
        if (labelText && n === 0) page.drawText(labelText, { x, y, size, font, color: theme.ink });
        page.drawText(packText(row), { x: x + (n === 0 ? labelW : 0), y, size, font, color: theme.muted });
        y -= size + 4;
      });
    }
  });
}

/**
 * The broker's back cover with its artwork and banner words kept (a backtick becomes an
 * apostrophe in the cover's own font) and its contact block set again from the broker's
 * legal details, so it names the same company as the front cover. Covers whose layout is
 * not recognised are copied as they are. A cover with named fields is filled from `fill`
 * (see addTemplateCover). Returns the number of pages added.
 */
export async function addBrandedBackCover(out, backAsset, fonts, legal, fill) {
  if (!backAsset) return 0;
  const bytes = readBytes(backAsset.storage_ref);
  const isPdf = (backAsset.mime || "").includes("pdf") || backAsset.storage_ref.endsWith(".pdf");
  if (!isPdf) {
    const page = out.addPage([PAGE.w, PAGE.h]);
    const image = bytes[0] === 0xff ? await out.embedJpg(bytes) : await out.embedPng(bytes);
    page.drawImage(image, { x: 0, y: 0, width: PAGE.w, height: PAGE.h });
    return 1;
  }
  const filled = await addTemplateCover(out, bytes, fonts, fill, { allPages: true });
  if (filled) return filled;
  const copyAll = async (data) => {
    const src = await PDFDocument.load(data);
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((page) => out.addPage(page));
    return pages;
  };
  const [first] = await extractTextItems(bytes);
  const layout = legal?.name ? contactLayout(first?.items || []) : null;
  if (!layout) return (await copyAll(bytes)).length;

  const isBanner = (x, y) => layout.banner.some((item) => Math.abs(item.x - x) < 1.5 && Math.abs(item.y - y) < 1.5);
  const src = await PDFDocument.load(bytes);
  stripPageText(src, src.getPage(0), isBanner, (body) => body.replace(/`/g, "\\222"));
  const stripped = await src.save();
  const [after] = await extractTextItems(stripped);
  const remaining = after?.items || [];
  if (remaining.length !== layout.banner.length || !remaining.every((item) => isBanner(item.x, item.y))) {
    return (await copyAll(bytes)).length;
  }
  const pages = await copyAll(stripped);
  drawContactBlock(pages[0], layout, legal, fonts);
  return pages.length;
}

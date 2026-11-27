import { LineCapStyle } from "pdf-lib";
import { MARK_EMPTY, MARK_TICKED } from "./docxTemplate.js";
import { BODY_BOTTOM, BODY_TOP, CONTENT_W, MARGIN, packText, wrapText } from "./packLayout.js";

/*
 * Lays out a Word template's content (see docxContent.js) in the pack's own style: accent part titles,
 * bold sub-headings, wrapped body text with hanging indents, bordered tables with tinted header rows,
 * drawn tick boxes, and bordered signature blocks. Each {{sig.role.field}} left in the text is not
 * drawn; its place is returned instead, so a signature, name or date can be put there later.
 */

const BODY = { size: 9, lineH: 13, after: 5 };
const CELL = { size: 8.5, lineH: 11.5, pad: 5, between: 2 };
const SIGNATURE_ROW = 44;
const SIGNATURE_LIFT = 26;
const FIELD_W = { signature: 150, default: 110 };
const SIG = /^\{\{\s*(sig\.[a-z_]+\.[a-z_]+)\s*\}\}$/;
const SPLIT = /(\{\{\s*sig\.[^{}]+\}\}|[\uE000\uE001]|\t|\n| +)/;
const LABELLED_FIELD = /([A-Za-z][A-Za-z /]*?)\s*:\s*\{\{\s*(sig\.[a-z_]+\.[a-z_]+)\s*\}\}/g;

const fieldOf = (token) => token.split(".").pop();

// pdf-lib measures with kerning but draws without it, so words placed one after another are measured glyph by glyph.
const glyphWidths = new WeakMap();
function measure(face, text, size) {
  let widths = glyphWidths.get(face);
  if (!widths) glyphWidths.set(face, (widths = new Map()));
  let total = 0;
  for (const ch of text) {
    let w = widths.get(ch);
    if (w == null) widths.set(ch, (w = face.widthOfTextAtSize(ch, 1)));
    total += w;
  }
  return total * size;
}

/** Words (bold and regular pieces joined when no space parts them), tabs, line breaks, tick marks and fields. */
function atomsOf(runs) {
  const atoms = [];
  let space = false;
  let word = null;
  const flush = () => {
    if (word) atoms.push(word);
    word = null;
  };
  for (const run of runs) {
    for (const part of String(run.text).split(SPLIT)) {
      if (!part) continue;
      if (part === "\t" || part === "\n") {
        flush();
        atoms.push({ kind: part === "\t" ? "tab" : "newline" });
        space = false;
      } else if (/^ +$/.test(part)) {
        flush();
        space = true;
      } else if (part === MARK_TICKED || part === MARK_EMPTY) {
        flush();
        atoms.push({ kind: "mark", ticked: part === MARK_TICKED, space });
        space = false;
      } else if (SIG.test(part)) {
        flush();
        atoms.push({ kind: "field", token: part.match(SIG)[1], space });
        space = false;
      } else {
        const text = packText(part);
        if (word && !space) word.pieces.push({ text, bold: run.bold });
        else {
          flush();
          word = { kind: "word", pieces: [{ text, bold: run.bold }], space };
        }
        space = false;
      }
    }
  }
  flush();
  return atoms;
}

class Layout {
  constructor({ font, bold }, { size, showFields }) {
    this.font = font;
    this.bold = bold;
    this.size = size;
    this.showFields = showFields;
    this.spaceW = measure(font, " ", size);
    this.markW = size * 0.9;
  }

  face(piece) {
    return piece.bold ? this.bold : this.font;
  }

  width(piece, text = piece.text) {
    return measure(this.face(piece), text, this.size);
  }

  widthOf(atom) {
    if (atom.kind === "word") return atom.pieces.reduce((w, piece) => w + this.width(piece), 0);
    if (atom.kind === "mark") return this.markW;
    if (atom.kind === "field") {
      return this.showFields ? measure(this.font, `{{${atom.token}}}`, this.size) : FIELD_W[fieldOf(atom.token)] || FIELD_W.default;
    }
    return 0;
  }

  /** A word too wide for a whole line, cut into pieces that fit. */
  split(atom, width) {
    const out = [];
    let pieces = [];
    let used = 0;
    for (const piece of atom.pieces) {
      let rest = piece.text;
      while (rest) {
        let cut = rest.length;
        while (cut > 1 && used + this.width(piece, rest.slice(0, cut)) > width) cut -= 1;
        if (used > 0 && used + this.width(piece, rest.slice(0, cut)) > width) {
          out.push({ kind: "word", pieces, space: false });
          pieces = [];
          used = 0;
          continue;
        }
        pieces.push({ text: rest.slice(0, cut), bold: piece.bold });
        used += this.width(piece, rest.slice(0, cut));
        rest = rest.slice(cut);
        if (rest) {
          out.push({ kind: "word", pieces, space: false });
          pieces = [];
          used = 0;
        }
      }
    }
    if (pieces.length) out.push({ kind: "word", pieces, space: false });
    if (out[0]) out[0].space = atom.space;
    return out;
  }

  /**
   * Lines of placed items for a paragraph `width` wide. The first line starts at firstX and later ones
   * at restX; tabs go to the paragraph's tab stops, its hanging indent, or the next half inch.
   */
  lines(atoms, { width, firstX = 0, restX = 0, tabs = [], hangAt = null }) {
    const lines = [];
    let line = [];
    let x = firstX;
    let afterTab = false;
    const next = () => {
      lines.push(line);
      line = [];
      x = restX;
      afterTab = false;
    };
    // A tick mark followed by a tab is a checklist line: the text hangs just after the box.
    if (atoms[0]?.kind === "mark" && atoms[1]?.kind === "tab") {
      atoms = [atoms[0], ...atoms.slice(2).map((atom, index) => (index === 0 ? { ...atom, space: true } : atom))];
      restX = firstX + this.markW + this.spaceW * 2;
    }
    for (let i = 0; i < atoms.length; i += 1) {
      const atom = atoms[i];
      if (atom.kind === "newline") {
        next();
        continue;
      }
      if (atom.kind === "tab") {
        const stops = [...tabs, ...(hangAt != null ? [hangAt] : [])].filter((stop) => stop > x + 0.5).sort((a, b) => a - b);
        const stop = stops[0] ?? (Math.floor(x / 36) + 1) * 36;
        if (stop >= width) next();
        else {
          x = stop;
          afterTab = true;
        }
        continue;
      }
      const w = this.widthOf(atom);
      let gap = atom.space && line.length && !afterTab ? (line[line.length - 1].atom.kind === "mark" ? this.spaceW * 2 : this.spaceW) : 0;
      if (line.length && x + gap + w > width) {
        next();
        gap = 0;
      }
      if (atom.kind === "word" && w > width - x) {
        const parts = this.split(atom, width - x);
        if (parts.length > 1) {
          atoms.splice(i, 1, ...parts);
          i -= 1;
          continue;
        }
      }
      line.push({ atom, x: x + gap, w });
      x += gap + w;
      afterTab = false;
    }
    lines.push(line);
    return lines.filter((placed, index) => placed.length || index === 0);
  }
}

/** Box with a green tick, or an empty box, sitting on the text baseline. */
function drawMark(page, x, baseline, size, ticked, theme) {
  const s = size * 0.9;
  page.drawRectangle({ x, y: baseline - 1, width: s, height: s, borderColor: theme.ink, borderWidth: 0.7 });
  if (!ticked) return;
  const line = (x1, y1, x2, y2) =>
    page.drawLine({
      start: { x: x + x1 * s, y: baseline - 1 + y1 * s },
      end: { x: x + x2 * s, y: baseline - 1 + y2 * s },
      thickness: s * 0.16,
      color: theme.ok,
      lineCap: LineCapStyle.Round,
    });
  line(0.2, 0.52, 0.42, 0.26);
  line(0.42, 0.26, 0.84, 0.82);
}

/** Paragraph indents, kept within a third of the width they sit in. */
function geometry(para, width) {
  const cap = width / 3;
  const left = Math.min(Math.max(0, para.left || 0), cap);
  const first = Math.min(Math.max(0, left - (para.hanging || 0) + (para.firstLine || 0)), cap);
  return {
    firstX: first,
    restX: left,
    hangAt: para.hanging > 0 ? left : null,
    tabs: (para.tabs || []).filter((stop) => stop < width),
  };
}

const runsText = (runs) => runs.map((run) => run.text).join("");

/**
 * Signature lines ("Name: {{sig.client.name}}", "Signature: … Date: …") become one bordered table per
 * party, kept on a page with the one or two lines above it ("THE CLIENT", "Signed for and on behalf of …").
 */
function signatureBlocks(blocks) {
  const out = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const pairsOf = (block) => {
      if (block?.type !== "para") return null;
      const text = runsText(block.runs);
      const pairs = [...text.matchAll(LABELLED_FIELD)];
      return pairs.length && !text.replace(LABELLED_FIELD, "").trim() ? pairs : null;
    };
    if (!pairsOf(blocks[i])) {
      out.push(blocks[i]);
      continue;
    }
    const rows = [];
    while (i < blocks.length && (pairsOf(blocks[i]) || (blocks[i].type === "gap" && pairsOf(blocks[i + 1])))) {
      for (const pair of pairsOf(blocks[i]) || []) {
        rows.push({
          header: false,
          cells: [
            { span: 1, shaded: true, paras: [{ runs: [{ text: pair[1].trim(), bold: true }] }] },
            { span: 1, shaded: false, paras: [{ runs: [{ text: `{{${pair[2]}}}`, bold: false }] }] },
          ],
        });
      }
      i += 1;
    }
    i -= 1;
    const lead = [];
    while (lead.length < 2 && out.length && out[out.length - 1].type === "para") lead.unshift(out.pop());
    out.push({ type: "group", blocks: [...lead, { type: "table", grid: [130, CONTENT_W - 130], rows }] });
  }
  return out;
}

/**
 * Draws `blocks` through a PackWriter from its current position, adding pages as needed. Returns the
 * place of every {{sig.*}} field: { token, page (index in the writer's document), x, y, w, h, nextX }.
 * `showFields` writes the fields' names where they sit, for a preview of the template.
 */
export function renderBlocks(writer, blocks, { showFields = false } = {}) {
  const { theme } = writer;
  const fonts = { font: writer.font, bold: writer.bold };
  const body = new Layout(fonts, { size: BODY.size, showFields });
  const small = new Layout(fonts, { size: 7.5, showFields });
  const cell = new Layout(fonts, { size: CELL.size, showFields });
  const places = [];
  const pageIndex = () => writer.doc.getPageCount() - 1;
  const atTop = () => !writer.page || writer.y >= BODY_TOP - 0.5;

  const place = (token, x, baseline, w, extra = {}) => {
    places.push({ token, page: pageIndex(), x, y: baseline, w, h: extra.h || 16, nextX: extra.nextX ?? x + w, pageWidth: writer.page.getSize().width });
  };

  const drawItems = (layout, items, originX, baseline, color, { cellRight, rowBottom } = {}) => {
    for (const { atom, x, w } of items) {
      const left = originX + x;
      if (atom.kind === "word") {
        let px = left;
        for (const piece of atom.pieces) {
          writer.page.drawText(piece.text, { x: px, y: baseline, size: layout.size, font: layout.face(piece), color });
          px += layout.width(piece);
        }
      } else if (atom.kind === "mark") {
        drawMark(writer.page, left, baseline, layout.size, atom.ticked, theme);
      } else if (atom.kind === "field") {
        if (showFields) writer.page.drawText(`{{${atom.token}}}`, { x: left, y: baseline, size: layout.size, font: layout.font, color: theme.muted });
        const signature = fieldOf(atom.token) === "signature";
        const right = cellRight ?? MARGIN + CONTENT_W;
        if (signature && rowBottom != null) place(atom.token, left, rowBottom + 8, right - left - CELL.pad, { h: SIGNATURE_ROW - 10, nextX: right });
        else place(atom.token, left, baseline, Math.max(w, right - left - (cellRight ? CELL.pad : 0)), { h: signature ? 34 : 16, nextX: right });
      }
    }
  };

  const paragraphLines = (para) => {
    const layout = para.kicker ? small : body;
    const atoms = atomsOf(para.kicker ? para.runs.map((run) => ({ ...run, bold: true })) : para.runs);
    return { layout, lines: layout.lines(atoms, { width: CONTENT_W, ...geometry(para, CONTENT_W) }) };
  };
  const hasSignature = (line) => line.some(({ atom }) => atom.kind === "field" && fieldOf(atom.token) === "signature");
  const paragraphHeight = (para) => {
    const { layout, lines } = paragraphLines(para);
    const lineH = para.kicker ? layout.size + 5 : BODY.lineH;
    return lines.reduce((h, line) => h + lineH + (hasSignature(line) ? SIGNATURE_LIFT : 0), 0) + (para.kicker ? 3 : BODY.after);
  };

  const paragraph = (para) => {
    if (para.pageBreak && !atTop()) writer.newPage();
    const { layout, lines } = paragraphLines(para);
    const lineH = para.kicker ? layout.size + 5 : BODY.lineH;
    if (para.kicker) writer.ensure(60);
    for (const line of lines) {
      const lift = hasSignature(line) ? SIGNATURE_LIFT : 0;
      writer.ensure(lineH + lift);
      writer.y -= lift;
      const end = line.length ? line[line.length - 1].x + line[line.length - 1].w : 0;
      const shift = para.align === "center" ? (CONTENT_W - end) / 2 : para.align === "right" ? CONTENT_W - end : 0;
      drawItems(layout, line, MARGIN + Math.max(0, shift), writer.y - layout.size, para.kicker ? theme.muted : theme.ink);
      writer.y -= lineH;
    }
    writer.y -= para.kicker ? 3 : BODY.after;
  };

  const heading = (block) => {
    if (block.pageBreak && !atTop()) writer.newPage();
    if (block.level === 1) {
      const lines = wrapText(block.text.toUpperCase(), writer.bold, 12.5, CONTENT_W);
      writer.ensure(90);
      if (!atTop()) writer.y -= 14;
      for (const line of lines) {
        writer.draw(line, MARGIN, writer.y - 12.5, { size: 12.5, font: writer.bold, color: theme.accent });
        writer.y -= 16;
      }
      writer.y -= 8;
      return;
    }
    const lines = wrapText(block.text, writer.bold, 10, CONTENT_W);
    writer.ensure(70);
    if (!atTop()) writer.y -= 6;
    for (const line of lines) {
      writer.draw(line, MARGIN, writer.y - 10, { size: 10, font: writer.bold });
      writer.y -= 14;
    }
    writer.y -= 4;
  };

  const tableLayout = (block) => {
    const total = block.grid.reduce((sum, w) => sum + w, 0);
    const columns = block.grid.length ? block.grid.map((w) => (w / total) * CONTENT_W) : [CONTENT_W];
    const edges = [MARGIN];
    columns.forEach((w) => edges.push(edges[edges.length - 1] + w));
    const rows = block.rows.map((row, rowIndex) => {
      let col = 0;
      const cells = row.cells.map((item) => {
        const from = Math.min(col, columns.length - 1);
        const to = Math.min(col + item.span, columns.length);
        col += item.span;
        const x = edges[from];
        const w = (edges[to] ?? edges[edges.length - 1]) - x;
        const inner = Math.max(10, w - CELL.pad * 2);
        const paras = item.merged ? [] : item.paras.map((para) => cell.lines(atomsOf(para.runs), { width: inner, ...geometry(para, inner) }));
        const lineCount = paras.reduce((n, lines) => n + lines.length, 0);
        const signature = paras.some((lines) => lines.some(hasSignature));
        const textH = lineCount * CELL.lineH + Math.max(0, paras.length - 1) * CELL.between;
        return { ...item, x, w, paras, height: Math.max(signature ? SIGNATURE_ROW : 0, textH + CELL.pad * 2 - 2) };
      });
      const allBold = row.cells.every((item) => item.paras.every((para) => para.runs.every((run) => run.bold || !run.text.trim())));
      const header = row.header || (rowIndex === 0 && block.rows.length > 1 && row.cells.every((item) => item.shaded) && allBold && row.cells.length > 1);
      return { header, cells, height: Math.max(CELL.lineH + CELL.pad * 2 - 2, ...cells.map((item) => item.height)) };
    });
    let headers = 0;
    while (headers < rows.length && rows[headers].header) headers += 1;
    return { rows, headers, height: rows.reduce((sum, row) => sum + row.height, 0) + 10 };
  };

  const drawRow = (row) => {
    const top = writer.y;
    const bottom = top - row.height;
    for (const item of row.cells) {
      writer.page.drawRectangle({
        x: item.x,
        y: bottom,
        width: item.w,
        height: row.height,
        color: row.header ? theme.tint : undefined,
        borderColor: theme.rule,
        borderWidth: 0.6,
      });
      let baseline = top - CELL.pad - CELL.size + 1;
      for (const lines of item.paras) {
        for (const line of lines) {
          drawItems(cell, line, item.x + CELL.pad, baseline, theme.ink, { cellRight: item.x + item.w, rowBottom: bottom });
          baseline -= CELL.lineH;
        }
        baseline -= CELL.between;
      }
    }
    writer.y = bottom;
  };

  const table = (block) => {
    const { rows, headers, height } = tableLayout(block);
    if (!rows.length) return;
    const room = writer.y - BODY_BOTTOM;
    if (height > room && height < 260) writer.newPage();
    else writer.ensure(rows.slice(0, headers + 1).reduce((sum, row) => sum + row.height, 0) + 4);
    rows.forEach((row, index) => {
      if (index >= headers && writer.y - row.height < BODY_BOTTOM) {
        writer.newPage();
        rows.slice(0, headers).forEach(drawRow);
      }
      drawRow(row);
    });
    writer.y -= 10;
  };

  const blockHeight = (block) =>
    block.type === "para" ? paragraphHeight(block) : block.type === "table" ? tableLayout(block).height : block.type === "heading" ? 40 : 6;

  const render = (block) => {
    if (block.type === "heading") heading(block);
    else if (block.type === "para") paragraph(block);
    else if (block.type === "table") table(block);
    else if (block.type === "break") {
      if (!atTop()) writer.newPage();
    } else if (block.type === "gap") {
      if (!atTop()) writer.y -= 6;
    } else if (block.type === "group") {
      const total = block.blocks.reduce((sum, item) => sum + blockHeight(item), 0);
      if (total < BODY_TOP - BODY_BOTTOM) writer.ensure(total);
      block.blocks.forEach(render);
    }
  };

  if (!writer.page) writer.newPage();
  signatureBlocks(blocks).forEach(render);
  return places;
}

import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

/*
 * Word templates use {{path}} text fields, [[CHECK:key]] / [[YN:key]] / [[SELECT:key|a|b]] answers,
 * [[UPLOAD:key|description]] and [[IMG:path]] evidence, [[COND:path]] … [[/COND]] blocks,
 * rows and blocks numbered [0], [1], [n], and {{sig.role.field}} signature fields.
 * The "SYSTEM LEGEND — NOT FOR ISSUE" part is removed before issue.
 */

const PARTS = /^word\/(document|header\d+|footer\d+)\.xml$/;
const TOKEN = /\{\{([^{}]+)\}\}|\[\[([A-Z]+):([^\]]*)\]\]/g;
const HAS_TOKEN = /\{\{[^{}]+\}\}|\[\[[A-Z]+:[^\]]*\]\]/;
const GENERIC = new Set(["path", "checks.*", "key", "checks.*.result", "sig.role.field"]);
const SIGNATURE_SPACE_TWIPS = 480;

export const BOX_TICKED = "\u2612";
export const BOX_EMPTY = "\u2610";

const unescapeXml = (text) =>
  String(text)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

const escapeXml = (text) =>
  String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const textOf = (xml) => unescapeXml([...xml.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join(""));

const splice = (text, start, end, insert) => text.slice(0, start) + insert + text.slice(end);

function lastIndexOfPattern(text, pattern, before) {
  let found = -1;
  for (const match of text.slice(0, before).matchAll(pattern)) found = match.index;
  return found;
}

/** Top-level elements of a stretch of WordprocessingML (paragraphs, tables, rows), nesting respected. */
function elements(xml, tags = ["w:p", "w:tbl", "w:sectPr"]) {
  const out = [];
  const opener = new RegExp(`<(${tags.join("|")})(?=[ >/])`, "g");
  let match;
  while ((match = opener.exec(xml))) {
    const tag = match[1];
    const start = match.index;
    const scan = new RegExp(`<${tag}(?=[ >/])[^>]*?(/?)>|</${tag}>`, "g");
    scan.lastIndex = start;
    let depth = 0;
    let end = xml.length;
    let step;
    while ((step = scan.exec(xml))) {
      if (step[0].startsWith("</")) depth -= 1;
      else if (step[1] !== "/") depth += 1;
      if (depth === 0) {
        end = step.index + step[0].length;
        break;
      }
    }
    out.push({ tag, start, end, xml: xml.slice(start, end) });
    opener.lastIndex = end;
  }
  return out;
}

function bodyOf(documentXml) {
  const open = documentXml.indexOf("<w:body>") + "<w:body>".length;
  const close = documentXml.lastIndexOf("</w:body>");
  return { head: documentXml.slice(0, open), body: documentXml.slice(open, close), tail: documentXml.slice(close) };
}

/** Drops the system legend and the page break before it, keeping the section break that follows. */
function removeSystemLegend(xml) {
  const marker = xml.indexOf("SYSTEM LEGEND");
  const endMarker = xml.indexOf("[[TEMPLATE_NOTES_END]]");
  if (marker < 0 || endMarker < marker) return xml;
  let start = lastIndexOfPattern(xml, /<w:p(?=[ >])/g, marker);
  if (start < 0) return xml;
  const pageBreak = xml.slice(0, start).match(/<w:p><w:r><w:br w:type="page"\/><\/w:r><\/w:p>$/);
  if (pageBreak) start -= pageBreak[0].length;
  const end = xml.indexOf("</w:p>", endMarker) + "</w:p>".length;
  return splice(xml, start, end, "");
}

const tokensIn = (xml) => [...textOf(xml).matchAll(TOKEN)].map((m) => m[0]);

function isGeneric(token) {
  const inner = token.replace(/^\{\{|\}\}$|^\[\[|\]\]$/g, "");
  const path = inner.includes(":") ? inner.split(":")[1].split("|")[0] : inner;
  return GENERIC.has(path.trim());
}

/** The template's key to its own colour coding ({{path}}, [[CHECK:key]] …) means nothing once filled. */
function removeTokenKey(body) {
  const items = elements(body);
  const cut = [];
  items.forEach((item, index) => {
    if (item.tag !== "w:tbl") return;
    const tokens = tokensIn(item.xml);
    if (!tokens.length || !tokens.every(isGeneric)) return;
    cut.push(item);
    const previous = items[index - 1];
    if (previous?.tag === "w:p" && /^legend$/i.test(textOf(previous.xml).trim())) cut.push(previous);
  });
  return cut.sort((a, b) => b.start - a.start).reduce((xml, item) => splice(xml, item.start, item.end, ""), body);
}

function paragraphWithText(paragraphXml, text) {
  const pPr = paragraphXml.match(/<w:pPr>[\s\S]*?<\/w:pPr>/)?.[0] || "";
  const runs = [...paragraphXml.matchAll(/<w:rPr>((?:(?!<\/w:rPr>)[\s\S])*)<\/w:rPr>\s*<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)];
  const plain = runs.reverse().find((run) => run[2].trim() && !HAS_TOKEN.test(run[2]));
  const rPr = plain ? `<w:rPr>${plain[1]}</w:rPr>` : "";
  return `<w:p>${pPr}<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

/** [[COND:path]] … [[/COND]]: kept without its markers when true, otherwise the block reads "Not applicable." */
function applyConditions(body, isTrue) {
  for (let guard = 0; guard < 50; guard += 1) {
    const items = elements(body);
    const open = items.findIndex((item) => item.tag === "w:p" && /\[\[COND:[^\]]+\]\]/.test(textOf(item.xml)));
    if (open < 0) break;
    const close = items.findIndex((item, index) => index > open && item.tag === "w:p" && textOf(item.xml).includes("[[/COND]]"));
    if (close < 0) break;
    const first = items[open];
    const last = items[close];
    const path = textOf(first.xml).match(/\[\[COND:([^\]]+)\]\]/)[1].trim();
    let replacement;
    if (isTrue(path)) {
      const opened = first.xml.replace(/(<w:t(?: [^>]*)?>)([^<]*?)\[\[COND:[^\]]+\]\]\s*/, "$1$2");
      const closing = last.xml.replace("[[/COND]]", "");
      replacement =
        (textOf(opened).trim() ? opened : "") + body.slice(first.end, last.start) + (textOf(closing).trim() ? closing : "");
    } else {
      replacement = paragraphWithText(first.xml, "Not applicable.");
    }
    body = splice(body, first.start, last.end, replacement);
  }
  return body;
}

function indexedArrays(xml, index) {
  const found = new Set();
  for (const token of tokensIn(xml)) {
    for (const match of token.matchAll(/([A-Za-z_][\w.]*)\[(\d+|n)\]/g)) {
      if (match[2] === String(index)) found.add(match[1]);
    }
  }
  return [...found];
}
const hasIndex = (xml, index) => tokensIn(xml).some((token) => token.includes(`[${index}]`));
const reindex = (xml, index) => xml.replace(/\[0\]/g, `[${index}]`);

/** Rows numbered [0], [1], [n] in a table: the [0] row repeats once per item; with none, one row of dashes. */
function expandTableRows(tableXml, countOf) {
  const rows = elements(tableXml, ["w:tr"]);
  const templates = rows.filter((row) => hasIndex(row.xml, 0));
  if (templates.length !== 1) return tableXml;
  const template = templates[0];
  const count = Math.max(0, ...indexedArrays(template.xml, 0).map(countOf));
  const generated = count
    ? Array.from({ length: count }, (_, index) => reindex(template.xml, index)).join("")
    : template.xml.replace(/\[0\]/g, "[none]");
  const extra = rows.filter((row) => row !== template && !hasIndex(row.xml, 0) && (hasIndex(row.xml, 1) || hasIndex(row.xml, "n")));
  return [...extra, template]
    .sort((a, b) => b.start - a.start)
    .reduce((xml, row) => splice(xml, row.start, row.end, row === template ? generated : ""), tableXml);
}

function renumberHeading(paragraphXml, index) {
  return paragraphXml.replace(/(<w:t(?: [^>]*)?>)([^<]*)(<\/w:t>)/g, (whole, open, text, close) =>
    `${open}${text.replace(/\b([A-Z]?)1\b/g, `$1${index + 1}`)}${close}`
  );
}

/** A heading and record table numbered [0], then [1] ("Repeat for each …"): one block per item. */
function expandRecordBlocks(body, countOf, emptyText) {
  for (let guard = 0; guard < 20; guard += 1) {
    const items = elements(body);
    const first = items.findIndex(
      (item) => item.tag === "w:tbl" && elements(item.xml, ["w:tr"]).filter((row) => hasIndex(row.xml, 0)).length > 1
    );
    if (first < 0) break;
    const arrays = indexedArrays(items[first].xml, 0);
    const second = items.findIndex((item, index) => index > first && item.tag === "w:tbl" && hasIndex(item.xml, 1) && !hasIndex(item.xml, 0));
    const last = second > 0 ? second : first;
    const heading = items[first - 1]?.tag === "w:p" && textOf(items[first - 1].xml).trim() ? items[first - 1] : null;
    const spacer = items.slice(first + 1, last).find((item) => item.tag === "w:p" && !textOf(item.xml).trim());
    const count = Math.max(0, ...arrays.map(countOf));
    const block = (index) => (heading ? renumberHeading(reindex(heading.xml, index), index) : "") + reindex(items[first].xml, index);
    const replacement = count
      ? Array.from({ length: count }, (_, index) => block(index)).join(spacer?.xml || "")
      : `<w:p><w:r><w:t xml:space="preserve">${escapeXml(emptyText(arrays))}</w:t></w:r></w:p>`;
    body = splice(body, (heading || items[first]).start, items[last].end, replacement);
  }
  return body;
}

function expandArrays(body, countOf, emptyText) {
  body = expandRecordBlocks(body, countOf, emptyText);
  const tables = elements(body).filter((item) => item.tag === "w:tbl" && hasIndex(item.xml, 0));
  return tables
    .sort((a, b) => b.start - a.start)
    .reduce((xml, table) => splice(xml, table.start, table.end, expandTableRows(table.xml, countOf)), body);
}

const LATER_IN_PPR =
  /<w:(ind|contextualSpacing|mirrorIndents|suppressOverlap|jc|textDirection|textAlignment|textboxTightWrap|outlineLvl|divId|cnfStyle|rPr|sectPr|pPrChange)\b/;

function setSpacingBefore(paragraphXml, twips) {
  const tag = `<w:spacing w:before="${twips}"/>`;
  if (!/<w:pPr>/.test(paragraphXml)) return paragraphXml.replace(/^<w:p([^>]*)>/, `<w:p$1><w:pPr>${tag}</w:pPr>`);
  return paragraphXml.replace(/<w:pPr>([\s\S]*?)<\/w:pPr>/, (whole, inner) => {
    if (/<w:spacing\b/.test(inner)) {
      return `<w:pPr>${inner.replace(/<w:spacing\b([^>]*?)\/>/, (spacing, attrs) => {
        const kept = attrs.replace(/\s+w:before(Autospacing|Lines)?="[^"]*"/g, "");
        return `<w:spacing${kept} w:before="${twips}"/>`;
      })}</w:pPr>`;
    }
    const at = inner.search(LATER_IN_PPR);
    return `<w:pPr>${at < 0 ? inner + tag : inner.slice(0, at) + tag + inner.slice(at)}</w:pPr>`;
  });
}

/** Room above each signature line (and the rest of its table row) for the signature itself. */
function makeSignatureRoom(body) {
  const marks = [...body.matchAll(/\{\{sig\.[\w.]+\.signature\}\}/g)].map((m) => m.index).reverse();
  for (const at of marks) {
    const rowStart = lastIndexOfPattern(body, /<w:tr(?=[ >])/g, at);
    const rowEnd = body.indexOf("</w:tr>", at);
    const inRow = rowStart >= 0 && body.lastIndexOf("</w:tr>", at) < rowStart && rowEnd > at;
    const start = inRow ? rowStart : lastIndexOfPattern(body, /<w:p(?=[ >])/g, at);
    const end = inRow ? rowEnd : body.indexOf("</w:p>", at) + "</w:p>".length;
    const stretch = body.slice(start, end);
    const spaced = elements(stretch, ["w:p"])
      .sort((a, b) => b.start - a.start)
      .reduce((xml, paragraph) => splice(xml, paragraph.start, paragraph.end, setSpacingBefore(paragraph.xml, SIGNATURE_SPACE_TWIPS)), stretch);
    body = splice(body, start, end, spaced);
  }
  return body;
}

/** The colour most of the document's own words are set in; filled values take it. */
function bodyColour(xml) {
  const counts = new Map();
  for (const match of xml.matchAll(/<w:r>(?:<w:rPr>((?:(?!<\/w:rPr>)[\s\S])*)<\/w:rPr>)?\s*<w:t(?: [^>]*)?>([^<]+)<\/w:t>/g)) {
    if (HAS_TOKEN.test(match[2])) continue;
    const colour = match[1]?.match(/<w:color w:val="([0-9A-Fa-f]{6}|auto)"/)?.[1] || "";
    counts.set(colour, (counts.get(colour) || 0) + match[2].length);
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
}

const RUN = /<w:r(?=[ >])(?:(?!<\/w:r>)[\s\S])*?<\/w:r>/g;
const ALONE_TOKEN = /^\s*(?:\{\{(?!sig\.)[^{}]+\}\}|\[\[[A-Z]+:[^\]]*\]\])\s*$/;
const LATER_IN_RPR =
  /<w:(spacing|w|kern|position|sz|szCs|highlight|u|effect|bdr|shd|fitText|vertAlign|rtl|cs|em|lang|eastAsianLayout|specVanish|oMath)\b/;

/** A run's own colour: a hex value, "auto", or null when it takes its style's colour. */
const runColour = (run) => run.match(/<w:color w:val="([0-9A-Fa-f]{6}|auto)"/)?.[1] ?? null;

function runsIn(xml, offset = 0) {
  return [...xml.matchAll(RUN)].map((m) => {
    const text = textOf(m[0]);
    return { start: offset + m.index, end: offset + m.index + m[0].length, xml: m[0], text, plain: Boolean(text.trim()) && !HAS_TOKEN.test(text) };
  });
}

function withColour(run, colour) {
  if (!/<w:rPr>/.test(run)) {
    return colour == null ? run : run.replace(/^<w:r([^>]*)>/, `<w:r$1><w:rPr><w:color w:val="${colour}"/></w:rPr>`);
  }
  return run.replace(/<w:rPr>((?:(?!<\/w:rPr>)[\s\S])*)<\/w:rPr>/, (whole, props) => {
    if (/<w:color [^>]*\/>/.test(props)) {
      return `<w:rPr>${props.replace(/<w:color [^>]*\/>/, colour == null ? "" : `<w:color w:val="${colour}"/>`)}</w:rPr>`;
    }
    if (colour == null) return whole;
    const tag = `<w:color w:val="${colour}"/>`;
    const at = props.search(LATER_IN_RPR);
    return `<w:rPr>${at < 0 ? props + tag : props.slice(0, at) + tag + props.slice(at)}</w:rPr>`;
  });
}

/** Every table cell at any depth, with its row and column, so a value can look along its column. */
function tableCells(xml, offset = 0, out = [], tableNo = { n: 0 }) {
  for (const table of elements(xml, ["w:tbl"]).filter((item) => item.tag === "w:tbl")) {
    const table_id = tableNo.n++;
    const inner = table.xml;
    elements(inner, ["w:tr"]).forEach((row, rowIndex) => {
      elements(row.xml.slice(row.xml.indexOf(">") + 1), ["w:tc"]).forEach((cell, col) => {
        const cellStart = offset + table.start + row.start + row.xml.indexOf(">") + 1 + cell.start;
        out.push({ table_id, row: rowIndex, col, start: cellStart, end: cellStart + cell.xml.length, xml: cell.xml });
        tableCells(cell.xml.slice(cell.xml.indexOf(">") + 1), cellStart + cell.xml.indexOf(">") + 1, out, tableNo);
      });
    });
  }
  return out;
}

const PARAGRAPH = /<w:p(?=[ >])(?:(?!<\/w:p>)[\s\S])*?<\/w:p>/g;
const isTab = (run) => /<w:p?tab\b/.test(run.xml);
const isLabel = (run) => /:\s*$/.test(run.text);

/** The colour of the value on a "Label: value" line, when that value is the document's own words. */
function labelledValueColour(paragraph) {
  const label = paragraph.runs.findIndex((run) => run.plain && isLabel(run));
  if (label < 0) return undefined;
  const value = paragraph.runs.slice(label + 1).find((run) => run.plain && !isLabel(run));
  return value ? runColour(value.xml) : undefined;
}

/**
 * Filled values take the colour of the text around them: words beside them on their own line (not a
 * label, and not across a tab), else the values of nearby "Label: value" lines, else other words in
 * their table cell, else the same column of their table, else the document's body colour.
 */
function recolourTokenRuns(xml, fallback) {
  const cells = tableCells(xml);
  const paragraphs = [...xml.matchAll(PARAGRAPH)].map((m, index) => {
    const start = m.index;
    const end = start + m[0].length;
    const cell = cells.filter((item) => item.start <= start && item.end >= end).sort((a, b) => b.start - a.start)[0] || null;
    return { index, start, end, xml: m[0], cell, runs: runsIn(m[0], start) };
  });
  const edits = [];
  for (const paragraph of paragraphs) {
    if (paragraph.xml.includes("<w:txbxContent")) continue;
    const { runs } = paragraph;
    const tokens = runs.filter((run) => ALONE_TOKEN.test(run.text));
    if (!tokens.length) continue;
    let around;
    const colourAround = () => {
      if (around !== undefined) return around;
      const siblings = paragraphs
        .filter((other) => other !== paragraph && other.cell === paragraph.cell && Math.abs(other.index - paragraph.index) <= 6)
        .sort((a, b) => Math.abs(a.index - paragraph.index) - Math.abs(b.index - paragraph.index));
      for (const other of siblings) {
        const colour = labelledValueColour(other);
        if (colour !== undefined) return (around = colour);
      }
      if (paragraph.cell) {
        for (const other of siblings) {
          const run = other.runs.find((item) => item.plain);
          if (run) return (around = runColour(run.xml));
        }
        const { cell } = paragraph;
        const column = cells
          .filter((item) => item.table_id === cell.table_id && item.col === cell.col && item.row !== cell.row)
          .sort((a, b) => Math.abs(a.row - cell.row) - Math.abs(b.row - cell.row));
        for (const neighbour of column) {
          const run = runsIn(neighbour.xml, neighbour.start).find((item) => item.plain);
          if (run) return (around = runColour(run.xml));
        }
      }
      return (around = fallback || null);
    };
    for (const token of tokens) {
      const at = runs.indexOf(token);
      const beside = (step) => {
        for (let i = at + step; i >= 0 && i < runs.length; i += step) {
          if (isTab(runs[i])) return null;
          if (runs[i].plain) return isLabel(runs[i]) ? null : runs[i];
        }
        return null;
      };
      const near = beside(-1) || beside(1);
      edits.push({ start: token.start, end: token.end, xml: withColour(token.xml, near ? runColour(near.xml) : colourAround()) });
    }
  }
  return edits.sort((a, b) => b.start - a.start).reduce((out, edit) => splice(out, edit.start, edit.end, edit.xml), xml);
}

const selectText = (options, chosen) => options.map((option) => `${option === chosen ? BOX_TICKED : BOX_EMPTY} ${option}`).join("   ");

function renderToken(token, data) {
  const field = token.match(/^\{\{([^{}]+)\}\}$/);
  if (field) {
    const path = field[1].trim();
    if (path.startsWith("sig.")) {
      const text = data.signatureText(path);
      return text == null ? token : String(text);
    }
    const text = data.text(path);
    return text == null || text === "" ? data.blank : String(text).replace(/\s*\n+\s*/g, ", ");
  }
  const [, kind, rest] = token.match(/^\[\[([A-Z]+):([^\]]*)\]\]$/) || [];
  const [key, ...options] = unescapeXml(rest || "").split("|").map((part) => part.trim());
  if (key.includes("[none]")) return data.blank;
  switch (kind) {
    case "CHECK":
      return data.answer(key) ? BOX_TICKED : BOX_EMPTY;
    case "YN": {
      const answer = data.answer(key);
      const yes = answer === true || answer === "yes";
      const no = answer === false || answer === "no";
      return `${yes ? BOX_TICKED : BOX_EMPTY} Yes   ${no ? BOX_TICKED : BOX_EMPTY} No`;
    }
    case "SELECT":
      return selectText(options, data.answer(key));
    case "UPLOAD":
      return data.upload(key, options.join("|")) || data.notProvided;
    case "IMG":
      return data.image(key) || data.blank;
    default:
      return token;
  }
}

function fillTokens(xml, data) {
  return xml.replace(/(<w:t(?: [^>]*)?>)([^<]*)(<\/w:t>)/g, (whole, open, text, close) => {
    if (!HAS_TOKEN.test(text)) return whole;
    const filled = text.replace(TOKEN, (token) => {
      const value = renderToken(token, data);
      return value === token ? token : escapeXml(value);
    });
    return `${/xml:space=/.test(open) ? open : '<w:t xml:space="preserve">'}${filled}${close}`;
  });
}

function lookup(source, path) {
  if (!source) return undefined;
  if (Object.prototype.hasOwnProperty.call(source, path)) return source[path];
  let node = source;
  for (const part of path.replace(/\[(\d+)\]/g, ".$1").split(".")) {
    if (node == null || typeof node !== "object") return undefined;
    node = node[part];
  }
  return node;
}

/**
 * Fills a Word template. `values` holds {{path}} text (nested objects or flat "a.b" keys; arrays for
 * numbered rows and blocks); `answers` the [[CHECK]], [[YN]] and [[SELECT]] keys; `conditions` the
 * [[COND]] paths; `uploads` and `images` the line printed for each piece of evidence. {{sig.*}} fields
 * stay in place, with room for the signature, unless `signatures` gives their text. `keepTokens` only
 * removes the system legend and makes room for signatures, for a preview of the template itself.
 */
export function fillDocx(bytes, {
  values = {},
  answers = {},
  conditions = {},
  uploads = {},
  images = {},
  signatures = {},
  blank = "—",
  notProvided = "Not provided",
  emptyList = () => "None.",
  keepTokens = false,
} = {}) {
  const files = unzipSync(new Uint8Array(bytes));
  if (keepTokens) {
    const xml = strFromU8(files["word/document.xml"]);
    const parts = bodyOf(removeSystemLegend(xml));
    files["word/document.xml"] = strToU8(parts.head + makeSignatureRoom(parts.body) + parts.tail);
    return Buffer.from(zipSync(files, { level: 6 }));
  }
  const data = {
    blank,
    notProvided,
    text: (path) => {
      const value = lookup(values, path);
      return Array.isArray(value) ? value.join(", ") : value;
    },
    answer: (key) => lookup(answers, key),
    upload: (key, description) => (typeof uploads === "function" ? uploads(key, description) : lookup(uploads, key)),
    image: (key) => (typeof images === "function" ? images(key) : lookup(images, key)),
    signatureText: (path) => lookup(signatures, path),
  };
  const countOf = (path) => {
    const value = lookup(values, path) ?? lookup(answers, path);
    return Array.isArray(value) ? value.length : 0;
  };
  for (const name of Object.keys(files).filter((file) => PARTS.test(file))) {
    let xml = strFromU8(files[name]);
    if (name === "word/document.xml") {
      xml = removeSystemLegend(xml);
      const colour = bodyColour(xml);
      const parts = bodyOf(xml);
      let body = removeTokenKey(parts.body);
      body = applyConditions(body, (path) => Boolean(lookup(conditions, path)));
      body = expandArrays(body, countOf, emptyList);
      body = makeSignatureRoom(body);
      xml = fillTokens(recolourTokenRuns(parts.head + body + parts.tail, colour), data);
    } else {
      xml = fillTokens(recolourTokenRuns(xml, bodyColour(xml)), data);
    }
    files[name] = strToU8(xml);
  }
  return Buffer.from(zipSync(files, { level: 6 }));
}

/** Every token the template uses outside its system legend, by kind. */
export function docxTokens(bytes) {
  const files = unzipSync(new Uint8Array(bytes));
  const found = {
    fields: new Set(),
    signatures: new Set(),
    checks: new Set(),
    yn: new Set(),
    selects: new Map(),
    uploads: new Map(),
    images: new Set(),
    conditions: new Set(),
  };
  for (const name of Object.keys(files).filter((file) => PARTS.test(file))) {
    let xml = strFromU8(files[name]);
    if (name === "word/document.xml") xml = removeSystemLegend(xml);
    for (const token of tokensIn(xml)) {
      if (isGeneric(token)) continue;
      const field = token.match(/^\{\{([^{}]+)\}\}$/);
      if (field) {
        (field[1].trim().startsWith("sig.") ? found.signatures : found.fields).add(field[1].trim());
        continue;
      }
      const [, kind, rest] = token.match(/^\[\[([A-Z]+):([^\]]*)\]\]$/) || [];
      const [key, ...options] = (rest || "").split("|").map((part) => part.trim());
      if (kind === "CHECK") found.checks.add(key);
      else if (kind === "YN") found.yn.add(key);
      else if (kind === "SELECT") found.selects.set(key, options);
      else if (kind === "UPLOAD") found.uploads.set(key, options.join("|"));
      else if (kind === "IMG") found.images.add(key);
      else if (kind === "COND") found.conditions.add(key);
    }
  }
  return found;
}

/** A .docx file: a zip holding word/document.xml. */
export function isWordFile(bytes) {
  if (!Buffer.from(bytes.slice(0, 4)).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return false;
  try {
    const found = unzipSync(new Uint8Array(bytes), { filter: (file) => file.name === "word/document.xml" });
    return Boolean(found["word/document.xml"]);
  } catch {
    return false;
  }
}

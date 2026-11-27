import { strFromU8, unzipSync } from "fflate";
import { bodyOf, elements, unescapeXml } from "./docxTemplate.js";

/*
 * Reads a filled Word template as content only: headings, paragraphs (bold runs, indents, tab stops),
 * page breaks and tables (column widths, header rows, merged cells). The template's own cover (before
 * its first section break) and back page (after the next one) are left out; the app lays out the rest.
 */

const attr = (xml, tag, name) => xml.match(new RegExp(`<${tag}\\b[^>]*?\\s${name}="([^"]*)"`))?.[1];
const points = (twips) => (twips == null ? 0 : Number(twips) / 20 || 0);
const isOn = (rPr, tag) => new RegExp(`<w:${tag}(?:\\s+w:val="(?:true|1|on)")?\\s*/>`).test(rPr);

const OUT_OF_FLOW = /<mc:AlternateContent>[\s\S]*?<\/mc:AlternateContent>|<w:drawing>[\s\S]*?<\/w:drawing>|<w:pict>[\s\S]*?<\/w:pict>/g;
const RUN = /<w:r(?=[ >])(?:(?!<\/w:r>)[\s\S])*?<\/w:r>/g;
const PIECE = /<w:t(?: [^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br(?: [^>]*)?\/>|<w:cr\/>/g;

function runsOf(paragraphXml) {
  const runs = [];
  let pageBreak = false;
  for (const match of paragraphXml.replace(OUT_OF_FLOW, "").matchAll(RUN)) {
    const rPr = match[0].match(/<w:rPr>([\s\S]*?)<\/w:rPr>/)?.[1] || "";
    const style = {
      bold: isOn(rPr, "b"),
      size: Number(attr(rPr, "w:sz", "w:val")) / 2 || null,
      spaced: Number(attr(rPr, "w:spacing", "w:val")) > 0,
      caps: isOn(rPr, "caps"),
    };
    let text = "";
    for (const piece of match[0].replace(/<w:rPr>[\s\S]*?<\/w:rPr>/, "").matchAll(PIECE)) {
      if (piece[0].startsWith("<w:tab")) text += "\t";
      else if (piece[0].startsWith("<w:br")) {
        if (/w:type="page"/.test(piece[0])) pageBreak = true;
        else text += "\n";
      } else if (piece[0] === "<w:cr/>") text += "\n";
      else text += unescapeXml(piece[1]);
    }
    if (!text) continue;
    const last = runs[runs.length - 1];
    if (last && last.bold === style.bold && last.size === style.size && last.spaced === style.spaced) last.text += text;
    else runs.push({ text, ...style });
  }
  return { runs, pageBreak };
}

function paragraphOf(xml) {
  const pPr = xml.match(/<w:pPr>([\s\S]*?)<\/w:pPr>/)?.[1] || "";
  if (/<w:sectPr\b/.test(pPr)) return { type: "section" };
  const { runs, pageBreak } = runsOf(xml);
  const text = runs.map((run) => run.text).join("");
  if (!text.trim()) return pageBreak || /<w:pageBreakBefore\s*\/>/.test(pPr) ? { type: "break" } : { type: "gap" };
  const style = attr(pPr, "w:pStyle", "w:val") || "";
  const heading = style.match(/^(?:Heading([1-3])|Title)$/);
  if (heading) return { type: "heading", level: heading[1] === "1" || !heading[1] ? 1 : 2, text: text.replace(/\s+/g, " ").trim(), pageBreak };
  const sized = runs.filter((run) => run.text.trim());
  const smallest = Math.min(...sized.map((run) => run.size || 10));
  if (smallest >= 16) return { type: "heading", level: 1, text: text.replace(/\s+/g, " ").trim(), pageBreak };
  if (smallest >= 13 && sized.every((run) => run.bold)) return { type: "heading", level: 2, text: text.replace(/\s+/g, " ").trim(), pageBreak };
  const tabs = [...(pPr.match(/<w:tabs>([\s\S]*?)<\/w:tabs>/)?.[1] || "").matchAll(/<w:tab\b[^>]*\/>/g)]
    .filter((tab) => attr(tab[0], "w:tab", "w:val") !== "clear")
    .map((tab) => points(attr(tab[0], "w:tab", "w:pos")))
    .sort((a, b) => a - b);
  const jc = attr(pPr, "w:jc", "w:val");
  return {
    type: "para",
    runs: runs.map(({ text: runText, bold }) => ({ text: runText, bold })),
    left: points(attr(pPr, "w:ind", "w:left") ?? attr(pPr, "w:ind", "w:start")),
    hanging: points(attr(pPr, "w:ind", "w:hanging")),
    firstLine: points(attr(pPr, "w:ind", "w:firstLine")),
    tabs,
    align: jc === "center" ? "center" : jc === "right" || jc === "end" ? "right" : "left",
    kicker: smallest <= 8 && sized.every((run) => run.spaced || run.caps),
    pageBreak,
  };
}

const inner = (xml) => xml.slice(xml.indexOf(">") + 1);

function tableOf(xml) {
  const grid = [...(xml.match(/<w:tblGrid>([\s\S]*?)<\/w:tblGrid>/)?.[1] || "").matchAll(/<w:gridCol\b[^>]*?w:w="(\d+)"/g)].map((m) => Number(m[1]));
  const rows = elements(inner(xml), ["w:tr"]).map((row) => {
    const trPr = row.xml.match(/<w:trPr>([\s\S]*?)<\/w:trPr>/)?.[1] || "";
    const cells = elements(inner(row.xml), ["w:tc"]).map((cell) => {
      const tcPr = cell.xml.match(/<w:tcPr>([\s\S]*?)<\/w:tcPr>/)?.[1] || "";
      const fill = attr(tcPr, "w:shd", "w:fill");
      const paras = [];
      for (const item of elements(inner(cell.xml), ["w:p", "w:tbl"])) {
        if (item.tag === "w:p") {
          const block = paragraphOf(item.xml);
          if (block.type === "para") paras.push(block);
          else if (block.type === "heading") paras.push({ type: "para", runs: [{ text: block.text, bold: true }], left: 0, hanging: 0, firstLine: 0, tabs: [], align: "left" });
        } else {
          for (const nested of tableOf(item.xml).rows) {
            const runs = nested.cells.flatMap((c, i) => [...(i ? [{ text: "  ", bold: false }] : []), ...c.paras.flatMap((p) => p.runs)]);
            paras.push({ type: "para", runs, left: 0, hanging: 0, firstLine: 0, tabs: [], align: "left" });
          }
        }
      }
      return {
        span: Number(attr(tcPr, "w:gridSpan", "w:val")) || 1,
        shaded: Boolean(fill && !/^(auto|FFFFFF)$/i.test(fill)),
        merged: /<w:vMerge\s*\/>|<w:vMerge w:val="continue"\s*\/>/.test(tcPr),
        paras,
      };
    });
    return { header: /<w:tblHeader(?:\s+w:val="(?:true|1|on)")?\s*\/>/.test(trPr), cells };
  });
  return { type: "table", grid, rows };
}

const textOfBlock = (block) =>
  block.type === "table"
    ? block.rows.flatMap((row) => row.cells.flatMap((cell) => cell.paras.map((p) => p.runs.map((r) => r.text).join("")))).join("\n")
    : block.type === "heading"
      ? block.text
      : (block.runs || []).map((run) => run.text).join("");

/**
 * The body of a filled template as blocks, and the plain lines of its own cover (for the details a
 * generated cover repeats, such as "Pack version DD-HS 1.1").
 */
export function docxBlocks(bytes) {
  const files = unzipSync(new Uint8Array(bytes), { filter: (file) => file.name === "word/document.xml" });
  const items = elements(bodyOf(strFromU8(files["word/document.xml"])).body);
  const blocks = items.map((item) => (item.tag === "w:tbl" ? tableOf(item.xml) : item.tag === "w:p" ? paragraphOf(item.xml) : { type: "section" }));
  const firstSection = blocks.findIndex((block) => block.type === "section");
  const coverEnd = firstSection >= 0 && firstSection < blocks.length * 0.3 ? firstSection : -1;
  const start = coverEnd + 1;
  const nextSection = blocks.findIndex((block, index) => index >= start && block.type === "section");
  const end = nextSection >= 0 ? nextSection : blocks.length;
  const content = blocks.slice(start, end);
  const filler = (block) => block.type === "gap" || block.type === "break";
  while (content.length && filler(content[0])) content.shift();
  while (content.length && filler(content[content.length - 1])) content.pop();
  const cover = blocks
    .slice(0, coverEnd >= 0 ? coverEnd : 0)
    .flatMap((block) => textOfBlock(block).split("\n"))
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return { blocks: content, cover };
}

export const blockText = textOfBlock;

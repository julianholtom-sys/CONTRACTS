import { extractTextItems } from "./detectFields.js";

const ROLE_KEYS = { client: "company", contractor: "supplier", broker: "agency", supplier: "spv", spv: "spv" };
const SIZES = { signature: { w: 190, h: 34, drop: 5 }, date: { w: 110, h: 16, drop: 4 }, text: { w: 230, h: 16, drop: 4 } };
const LABELS = { signature: "Signature", date: "Date", name: "Name", position: "Position" };

/** Where each {{token}} sits on the copy exported with them still showing: page, baseline, width, and what follows it. */
export async function tokenPlaces(markedPdfBytes) {
  const pages = await extractTextItems(markedPdfBytes);
  const places = [];
  for (const page of pages) {
    const lines = [];
    for (const item of [...page.items].sort((a, b) => b.y - a.y || a.x - b.x)) {
      const line = lines.find((row) => Math.abs(row.y - item.y) <= 2);
      if (line) line.items.push(item);
      else lines.push({ y: item.y, items: [item] });
    }
    for (const line of lines) {
      const items = line.items.sort((a, b) => a.x - b.x);
      let text = "";
      const spans = items.map((item) => {
        const span = { item, from: text.length };
        text += item.str;
        span.to = text.length;
        return span;
      });
      const xAt = (offset) => {
        const span = spans.find((row) => offset >= row.from && offset <= row.to) || spans[spans.length - 1];
        const share = span.to > span.from ? (offset - span.from) / (span.to - span.from) : 0;
        return span.item.x + span.item.w * share;
      };
      for (const match of text.matchAll(/\{\{([^{}]+)\}\}/g)) {
        const x = xAt(match.index);
        const end = xAt(match.index + match[0].length);
        const next = items.find((item) => item.x > end + 1);
        const owner = spans.find((row) => match.index >= row.from && match.index < row.to)?.item;
        places.push({
          token: match[1].trim(),
          page: page.pageIndex,
          x,
          y: line.y,
          w: end - x,
          size: owner?.h || 10,
          nextX: next ? next.x : null,
          pageWidth: page.width,
        });
      }
    }
  }
  return places;
}

/** Signing boxes for the {{sig.role.field}} places, in the page's own coordinates. */
export function signingFields(places) {
  const fields = [];
  for (const place of places) {
    const match = place.token.match(/^sig\.(\w+)\.(signature|date|name|position)$/);
    if (!match || !ROLE_KEYS[match[1]]) continue;
    const kind = match[2];
    const type = kind === "signature" ? "signature" : kind === "date" ? "date" : "text";
    const size = SIZES[type];
    const limit = Math.min(place.nextX != null ? place.nextX - 8 : Infinity, place.pageWidth - 36);
    fields.push({
      role_key: ROLE_KEYS[match[1]],
      field_key: `${match[1]}_${kind}`,
      label: LABELS[kind],
      field_type: type,
      page: place.page,
      x: place.x,
      y: place.y - size.drop,
      w: Math.max(60, Math.min(size.w, limit - place.x)),
      h: size.h,
    });
  }
  return fields;
}

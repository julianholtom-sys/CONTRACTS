const ROLE_KEYS = { client: "company", contractor: "supplier", broker: "agency", supplier: "spv", spv: "spv" };
const SIZES = { signature: { w: 190, h: 34, drop: 5 }, date: { w: 110, h: 16, drop: 4 }, text: { w: 230, h: 16, drop: 4 } };
const LABELS = { signature: "Signature", date: "Date", name: "Name", position: "Position" };

/** Signing boxes for the {{sig.role.field}} places (see docLayout.js), in the page's own coordinates. */
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

const METHODS = new Set(["drawn", "typed", "uploaded"]);

/** Must match the fonts bundled in client/src/signatureFonts.js. */
export const SIGNATURE_FONTS = [
  "Great Vibes",
  "Dancing Script",
  "Homemade Apple",
  "Sacramento",
  "Mr Dafoe",
  "Herr Von Muellerhoff",
];

const MAX_DATA_URL = 8 * 1024 * 1024;

/** Tallest a signature is stamped, in PDF points, however tall its box is. */
export const SIGNATURE_MAX_HEIGHT = 30;

export function readSignatureInput({ signatureDataUrl, method, font } = {}) {
  const dataUrl = String(signatureDataUrl || "");
  if (!dataUrl.startsWith("data:image/png;base64,")) throw new Error("Add your signature");
  if (dataUrl.length > MAX_DATA_URL) throw new Error("The signature image is too large");
  const kind = METHODS.has(method) ? method : "drawn";
  return {
    dataUrl,
    method: kind,
    font: kind === "typed" && SIGNATURE_FONTS.includes(font) ? font : null,
  };
}

export function describeSignature(method, font) {
  if (method === "typed") return font ? `Typed signature (${font})` : "Typed signature";
  if (method === "uploaded") return "Uploaded signature image";
  return "Drawn signature";
}

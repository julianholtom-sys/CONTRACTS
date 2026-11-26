const METHODS = new Set(["drawn", "typed", "uploaded"]);

const MAX_DATA_URL = 8 * 1024 * 1024;

/** Tallest a signature is stamped, in PDF points, however tall its box is. */
export const SIGNATURE_MAX_HEIGHT = 30;

export function readSignatureInput({ signatureDataUrl, method } = {}) {
  const dataUrl = String(signatureDataUrl || "");
  if (!dataUrl.startsWith("data:image/png;base64,")) throw new Error("Add your signature");
  if (dataUrl.length > MAX_DATA_URL) throw new Error("The signature image is too large");
  return { dataUrl, method: METHODS.has(method) ? method : "drawn" };
}

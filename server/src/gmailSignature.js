export function extractGmailFragment(html) {
  let out = String(html || "");
  const start = out.indexOf("<!--StartFragment-->");
  const end = out.indexOf("<!--EndFragment-->");
  if (start !== -1 && end !== -1 && end > start) {
    out = out.slice(start + "<!--StartFragment-->".length, end);
  }
  out = out.replace(/<\/?(html|head|body|meta|link|xml)[^>]*>/gi, "");
  out = out.replace(/<style[\s\S]*?<\/style>/gi, "");
  return sanitizeGmailHtml(out).trim();
}

export function sanitizeGmailHtml(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
    .replace(/on\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/javascript:/gi, "");
}

export function htmlToText(html) {
  const withBreaks = String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  return withBreaks.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function normalizeGmailSignature(html, text) {
  const cleanHtml = extractGmailFragment(html || "");
  const cleanText = String(text || "").trim() || htmlToText(cleanHtml);
  return { html: cleanHtml, text: cleanText };
}

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

function sniffImageMime(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return "image/gif";
  }
  if (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

function assertSafeImageUrl(raw) {
  let parsed;
  try {
    parsed = new URL(String(raw || "").trim());
  } catch {
    throw new Error("Invalid image URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Unsupported image URL");
  }
  const host = parsed.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    host.endsWith(".local") ||
    /^(10|127|169\.254|192\.168|172\.(1[6-9]|2\d|3[0-1]))\./.test(host)
  ) {
    throw new Error("Unsupported image URL");
  }
  return parsed.toString();
}

export async function fetchRemoteImageDataUrl(rawUrl) {
  const url = assertSafeImageUrl(rawUrl);
  const res = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(8000),
    headers: {
      Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    },
  });
  if (!res.ok) throw new Error("Image could not be downloaded");
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length || buf.length > MAX_IMAGE_BYTES) {
    throw new Error("Image is missing or too large");
  }
  const headerType = String(res.headers.get("content-type") || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  const mime = headerType.startsWith("image/") ? headerType : sniffImageMime(buf);
  if (!mime) throw new Error("URL was not an image");
  return `data:${mime};base64,${buf.toString("base64")}`;
}

const ALLOWED_TAGS = new Set([
  "a",
  "b",
  "blockquote",
  "br",
  "div",
  "em",
  "font",
  "h1",
  "h2",
  "h3",
  "h4",
  "hr",
  "i",
  "img",
  "li",
  "ol",
  "p",
  "s",
  "span",
  "strike",
  "strong",
  "sub",
  "sup",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
]);

const ALLOWED_ATTR = new Set([
  "alt",
  "border",
  "cellpadding",
  "cellspacing",
  "class",
  "color",
  "colspan",
  "data-src",
  "dir",
  "face",
  "height",
  "href",
  "rowspan",
  "size",
  "referrerpolicy",
  "src",
  "srcset",
  "style",
  "target",
  "title",
  "width",
]);

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
  if (typeof DOMParser === "undefined") {
    return String(html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/on\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
      .replace(/javascript:/gi, "");
  }
  const doc = new DOMParser().parseFromString(`<div>${html || ""}</div>`, "text/html");
  const root = doc.body.firstElementChild;
  if (!root) return "";
  cleanNode(root);
  return root.innerHTML.trim();
}

function cleanNode(node) {
  const children = [...node.childNodes];
  for (const child of children) {
    if (child.nodeType === Node.COMMENT_NODE) {
      child.remove();
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const tag = child.tagName.toLowerCase();
    if (tag === "script" || tag === "iframe" || tag === "object" || tag === "embed") {
      child.remove();
      continue;
    }
    if (!ALLOWED_TAGS.has(tag)) {
      const parent = child.parentNode;
      while (child.firstChild) parent.insertBefore(child.firstChild, child);
      child.remove();
      continue;
    }
    for (const attr of [...child.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on") || !ALLOWED_ATTR.has(name)) {
        child.removeAttribute(attr.name);
        continue;
      }
      if ((name === "href" || name === "src") && /^\s*javascript:/i.test(attr.value)) {
        child.removeAttribute(attr.name);
      }
    }
    cleanNode(child);
  }
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

export function textToSimpleHtml(text) {
  const escaped = String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  if (!escaped.trim()) return "";
  return escaped
    .split(/\n{2,}/)
    .map((block) => `<div>${block.replace(/\n/g, "<br/>")}</div>`)
    .join("");
}

export function isHtmlSignatureFile(file) {
  if (!file) return false;
  return file.type === "text/html" || /\.html?$/i.test(file.name || "");
}

export function collectClipboardImages(clipboardData) {
  const out = [];
  const seen = new Set();
  if (!clipboardData) return out;
  const push = (file) => {
    if (!file || !String(file.type || "").startsWith("image/")) return;
    const key = `${file.type}:${file.size}:${file.name || ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(file);
  };
  const items = clipboardData.items ? [...clipboardData.items] : [];
  for (const item of items) {
    if (item.kind === "file" && String(item.type || "").startsWith("image/")) {
      push(item.getAsFile());
    }
  }
  if (clipboardData.files) {
    for (const file of clipboardData.files) push(file);
  }
  return out;
}

export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Could not read image"));
    reader.readAsDataURL(file);
  });
}

export function isLocalImageSrc(src) {
  const s = String(src || "").trim();
  return s.startsWith("data:") || s.startsWith("/api/");
}

export function absolutizeImageSrc(src) {
  const s = String(src || "").trim();
  if (!s) return s;
  if (s.startsWith("//")) return `https:${s}`;
  if (s.startsWith("/mail/") || s.startsWith("/a/")) {
    return `https://mail.google.com${s}`;
  }
  return s;
}

function parseSignatureRoot(html) {
  const doc = new DOMParser().parseFromString(`<div>${html || ""}</div>`, "text/html");
  return { doc, root: doc.body.firstElementChild };
}

export async function inlineSignatureImages(html, files = [], { fetchRemote } = {}) {
  const { root } = parseSignatureRoot(html || "");
  if (!root) return html || "";
  const clipboardFiles = [...files];
  let fileIndex = 0;
  const imgs = [...root.querySelectorAll("img")];

  for (const img of imgs) {
    const rawSrc = img.getAttribute("src") || img.getAttribute("data-src") || "";
    const src = absolutizeImageSrc(rawSrc);
    img.setAttribute("referrerpolicy", "no-referrer");
    if (src && src !== rawSrc) img.setAttribute("src", src);
    if (isLocalImageSrc(img.getAttribute("src") || "")) continue;

    if (fileIndex < clipboardFiles.length) {
      img.setAttribute("src", await fileToDataUrl(clipboardFiles[fileIndex]));
      fileIndex += 1;
      continue;
    }

    const current = img.getAttribute("src") || src;
    if (current.startsWith("blob:")) {
      try {
        const blob = await fetch(current).then((r) => r.blob());
        img.setAttribute("src", await fileToDataUrl(blob));
        continue;
      } catch {
        /* try remote next */
      }
    }

    if (fetchRemote && /^https?:/i.test(current)) {
      try {
        const dataUrl = await fetchRemote(current);
        if (dataUrl) {
          img.setAttribute("src", dataUrl);
        }
      } catch {
        /* keep google URL + no-referrer as last resort */
      }
    }
  }

  while (fileIndex < clipboardFiles.length) {
    const dataUrl = await fileToDataUrl(clipboardFiles[fileIndex]);
    fileIndex += 1;
    const img = root.ownerDocument.createElement("img");
    img.setAttribute("src", dataUrl);
    img.setAttribute("alt", "");
    img.setAttribute("style", "max-width:480px;height:auto");
    img.setAttribute("referrerpolicy", "no-referrer");
    const wrap = root.ownerDocument.createElement("div");
    wrap.appendChild(img);
    root.appendChild(wrap);
  }

  return root.innerHTML.trim();
}

export function replaceBrokenSignatureImage(html, localSrc) {
  const { root } = parseSignatureRoot(html || "");
  if (!root) {
    return `<p><img src="${localSrc}" alt="" style="max-width:480px;height:auto" /></p>`;
  }
  const broken = [...root.querySelectorAll("img")].find((img) => {
    const src = img.getAttribute("src") || "";
    return !isLocalImageSrc(src);
  });
  if (broken) {
    broken.setAttribute("src", localSrc);
    broken.setAttribute("referrerpolicy", "no-referrer");
    return root.innerHTML.trim();
  }
  if (!root.querySelector("img")) {
    root.insertAdjacentHTML(
      "beforeend",
      `<p><img src="${localSrc}" alt="" style="max-width:480px;height:auto" /></p>`
    );
  }
  return root.innerHTML.trim();
}

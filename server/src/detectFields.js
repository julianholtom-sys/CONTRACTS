import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import {
  PDFDocument,
  PDFCheckBox,
  PDFTextField,
  PDFSignature,
} from "pdf-lib";

const require = createRequire(import.meta.url);

export const ROLE_LABELS = {
  company: "Client",
  agency: "Broker",
  supplier: "Contractor",
  spv: "Supplier (SPV)",
};

const CORE_ROLES = ["supplier", "agency", "company"];

const SIZES = {
  signature: { w: 180, h: 36 },
  initials: { w: 56, h: 28 },
  date: { w: 110, h: 18 },
  text: { w: 200, h: 18 },
  checkbox: { w: 14, h: 14 },
};

const HEADING_RE =
  /^(the\s+)?(client|agency|broker|contractor|supplier|company)\s*$/i;

function slugPart(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 40);
}

function clampBox(box, pageWidth, pageHeight) {
  const w = Math.min(box.w, Math.max(40, pageWidth - 24));
  const h = Math.min(box.h, Math.max(12, pageHeight - 24));
  const x = Math.min(Math.max(12, box.x), pageWidth - w - 12);
  const y = Math.min(Math.max(12, box.y), pageHeight - h - 12);
  return { ...box, x, y, w, h };
}

function inferTypeFromText(text) {
  const t = String(text || "");
  if (/\binitials?\b/i.test(t)) return "initials";
  if (
    /\b(signature|signed by|sign here|signatory|signed for and on behalf|sign below)\b/i.test(
      t
    )
  ) {
    return "signature";
  }
  if (/\b(i (agree|accept|confirm|acknowledge)|acceptance of these terms)\b/i.test(t)) {
    return "checkbox";
  }
  if (/\bdated?\b/i.test(t) && !/\bcandidate\b/i.test(t)) return "date";
  if (/\b(print name|printed name|full name|name of signatory|signer's name)\b/i.test(t)) {
    return "text";
  }
  if (/\b(position|job title|capacity|title)\b/i.test(t) && !/\bcontract title\b/i.test(t)) {
    return "text";
  }
  if (/\b(company name|registered name|trading name)\b/i.test(t)) return "text";
  if (/[_]{5,}|\.{8,}/.test(t)) return "text";
  return null;
}

function inferRoleFromText(text) {
  const t = String(text || "");
  if (/\b(sub-?contractor|contractor)\b/i.test(t)) return "supplier";
  if (/\b(supplier|spv)\b/i.test(t)) return "spv";
  if (/\b(broker|agency|recruitment)\b/i.test(t)) return "agency";
  if (/\b(client|hirer|employer)\b/i.test(t)) return "company";
  if (/\bthe company\b/i.test(t) && !/\bcompany name\b/i.test(t)) return "company";
  return null;
}

function headingRole(text) {
  const m = String(text || "").trim().match(HEADING_RE);
  if (!m) return null;
  const key = m[2].toLowerCase();
  if (key === "client" || key === "company") return "company";
  if (key === "agency" || key === "broker") return "agency";
  if (key === "contractor") return "supplier";
  if (key === "supplier") return "spv";
  return null;
}

function overlaps(a, b) {
  if (a.page !== b.page) return false;
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  const minArea = Math.min(a.w * a.h, b.w * b.h) || 1;
  return inter / minArea > 0.45;
}

function fieldLabel(roleKey, type, raw) {
  const party = ROLE_LABELS[roleKey] || "Party";
  const cleaned = String(raw || "")
    .replace(/[_.=]{3,}/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (type === "signature") return cleaned || `${party} signature`;
  if (type === "initials") return cleaned || `${party} initials`;
  if (type === "date") return cleaned || `${party} date`;
  if (type === "checkbox") return cleaned || `${party} acceptance`;
  return cleaned || `${party} details`;
}

async function detectAcroForm(bytes) {
  const out = [];
  try {
    const pdf = await PDFDocument.load(bytes);
    const form = pdf.getForm();
    const pages = pdf.getPages();
    for (const field of form.getFields()) {
      const name = field.getName() || "field";
      let fieldType = "text";
      if (field instanceof PDFCheckBox) fieldType = "checkbox";
      else if (field instanceof PDFSignature) fieldType = "signature";
      else if (field instanceof PDFTextField) {
        const lower = name.toLowerCase();
        if (/sign/.test(lower)) fieldType = "signature";
        else if (/date/.test(lower)) fieldType = "date";
        else if (/initial/.test(lower)) fieldType = "initials";
        else fieldType = "text";
      } else if (/sign/.test(name.toLowerCase())) {
        fieldType = "signature";
      }
      const roleKey = inferRoleFromText(name);
      const widgets = field.acroField.getWidgets();
      for (const widget of widgets) {
        const rect = widget.getRectangle();
        let pageIndex = 0;
        try {
          const pref = widget.P();
          const found = pages.findIndex((p) => p.ref === pref);
          if (found >= 0) pageIndex = found;
        } catch {
          /* widget page optional */
        }
        const page = pages[pageIndex] || pages[0];
        const { width, height } = page.getSize();
        out.push(
          clampBox(
            {
              role_key: roleKey,
              field_key: slugPart(name) || `acro_${out.length}`,
              label: name.replace(/[._]/g, " "),
              field_type: fieldType,
              page: pageIndex,
              x: rect.x,
              y: rect.y,
              w: rect.width || SIZES[fieldType].w,
              h: rect.height || SIZES[fieldType].h,
              source: "acroform",
            },
            width,
            height
          )
        );
      }
    }
  } catch {
    return [];
  }
  return out;
}

export async function extractTextItems(bytes) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  try {
    const workerPath = require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href;
  } catch {
    /* worker optional in Node */
  }
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: true,
    isEvalSupported: false,
    disableFontFace: true,
    stopAtErrors: false,
  }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent({ includeMarkedContent: false });
    const items = (content.items || [])
      .filter((item) => item.str && String(item.str).trim())
      .map((item) => {
        const t = item.transform || [1, 0, 0, 1, 0, 0];
        return {
          str: String(item.str),
          x: t[4],
          y: t[5],
          w: item.width || Math.abs(t[0]) * String(item.str).length * 0.5,
          h: item.height || Math.abs(t[3]) || 10,
        };
      });
    pages.push({
      pageIndex: i - 1,
      width: viewport.width,
      height: viewport.height,
      items,
    });
    page.cleanup();
  }
  await doc.destroy();
  return pages;
}

function itemsToLines(page) {
  const sorted = [...page.items].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const item of sorted) {
    const line = lines.find((row) => Math.abs(row.y - item.y) <= 4);
    if (line) {
      line.items.push(item);
      line.y = (line.y * (line.items.length - 1) + item.y) / line.items.length;
    } else {
      lines.push({ y: item.y, items: [item], page: page.pageIndex });
    }
  }
  return lines.map((line) => {
    const items = line.items.sort((a, b) => a.x - b.x);
    const last = items[items.length - 1];
    return {
      page: line.page,
      y: line.y,
      x: items[0].x,
      endX: last.x + last.w,
      h: Math.max(...items.map((i) => i.h)),
      text: items.map((i) => i.str).join(" ").replace(/\s+/g, " ").trim(),
      items,
    };
  });
}

function boxForLine(line, type, pageWidth, pageHeight) {
  const size = SIZES[type] || SIZES.text;
  const rightSpace = pageWidth - line.endX - 20;
  if (rightSpace >= size.w * 0.6) {
    return clampBox(
      {
        x: line.endX + 10,
        y: line.y - 4,
        w: Math.min(size.w, rightSpace),
        h: Math.max(size.h, line.h + 4),
      },
      pageWidth,
      pageHeight
    );
  }
  return clampBox(
    {
      x: line.x,
      y: Math.max(12, line.y - size.h - 8),
      w: size.w,
      h: size.h,
    },
    pageWidth,
    pageHeight
  );
}

function detectFromTextPages(pages) {
  const out = [];
  let currentRole = null;
  for (const page of pages) {
    const lines = itemsToLines(page);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const heading = headingRole(line.text);
      if (heading) {
        currentRole = heading;
        continue;
      }
      const next = lines[i + 1];
      let type = inferTypeFromText(line.text);
      if (!type && next && /^[_.=]{5,}$/.test(next.text.replace(/\s/g, ""))) {
        type = inferTypeFromText(line.text) || "text";
      }
      if (!type) continue;
      if (line.text.length > 90 && type !== "checkbox") continue;
      const roleKey =
        inferRoleFromText(line.text) ||
        currentRole ||
        null;
      const box = boxForLine(line, type, page.width, page.height);
      out.push({
        role_key: roleKey,
        field_key: `${roleKey || "party"}_${type}_p${page.pageIndex}_${out.length}`,
        label: fieldLabel(roleKey, type, line.text),
        field_type: type,
        page: page.pageIndex,
        ...box,
        source: "text",
      });
    }
  }
  return out;
}

function expandUnassigned(fields, _kind) {
  const assigned = fields.filter((f) => f.role_key);
  const unassigned = fields.filter((f) => !f.role_key);
  if (!unassigned.length) return assigned;
  const extras = [];
  for (const field of unassigned) {
    if (!["signature", "checkbox", "initials"].includes(field.field_type)) continue;
    CORE_ROLES.forEach((role, index) => {
      extras.push({
        ...field,
        role_key: role,
        field_key: `${role}_${field.field_type}_p${field.page}_${index}`,
        label: `${ROLE_LABELS[role]} — ${field.label || "acceptance"}`,
        y: field.y - index * (field.h + 10),
      });
    });
  }
  return [...assigned, ...extras];
}

function ensureMasterSignatures(fields, pages) {
  const last = pages[pages.length - 1] || { pageIndex: 0, width: 595, height: 842 };
  let y = 70;
  for (const role of CORE_ROLES) {
    if (fields.some((f) => f.role_key === role && f.field_type === "signature")) continue;
    fields.push(
      clampBox(
        {
          role_key: role,
          field_key: `${role}_sig`,
          label: `${ROLE_LABELS[role]} signature`,
          field_type: "signature",
          page: last.pageIndex,
          x: 50,
          y,
          w: SIZES.signature.w,
          h: SIZES.signature.h,
          source: "fallback",
        },
        last.width,
        last.height
      )
    );
    y += 50;
  }
  for (const role of CORE_ROLES) {
    if (fields.some((f) => f.role_key === role && f.field_type === "date")) continue;
    const sig = fields.find((f) => f.role_key === role && f.field_type === "signature");
    const page =
      pages.find((item) => item.pageIndex === (sig?.page ?? last.pageIndex)) || last;
    fields.push(
      clampBox(
        {
          role_key: role,
          field_key: `${role}_date`,
          label: `${ROLE_LABELS[role]} date`,
          field_type: "date",
          page: sig?.page ?? last.pageIndex,
          x: (sig?.x ?? 50) + (sig?.w ?? 180) + 16,
          y: sig?.y ?? 70,
          w: SIZES.date.w,
          h: SIZES.date.h,
          source: "fallback",
        },
        page.width,
        page.height
      )
    );
  }
  return fields;
}

function dedupe(fields) {
  const kept = [];
  for (const field of fields) {
    if (kept.some((row) => overlaps(row, field))) continue;
    kept.push(field);
  }
  return kept;
}

export async function detectPdfFields(bytes, { kind = "master" } = {}) {
  const acro = await detectAcroForm(bytes);
  let pages = [];
  let textFields = [];
  try {
    pages = await extractTextItems(bytes);
    textFields = detectFromTextPages(pages);
  } catch {
    pages = [];
  }
  const merged = [];
  for (const field of acro) {
    merged.push(field);
  }
  for (const field of textFields) {
    if (merged.some((row) => overlaps(row, field))) continue;
    merged.push(field);
  }
  let fields = expandUnassigned(merged, kind).filter((f) => f.role_key);
  if (kind === "master") {
    if (!pages.length) {
      try {
        const pdf = await PDFDocument.load(bytes);
        pages = pdf.getPages().map((page, pageIndex) => {
          const { width, height } = page.getSize();
          return { pageIndex, width, height, items: [] };
        });
      } catch {
        pages = [{ pageIndex: 0, width: 595.28, height: 841.89, items: [] }];
      }
    }
    fields = ensureMasterSignatures(fields, pages);
  }
  return dedupe(fields).map((field, index) => ({
    ...field,
    field_key: field.field_key || `${field.role_key}_${field.field_type}_${index}`,
    label: fieldLabel(field.role_key, field.field_type, field.label),
  }));
}

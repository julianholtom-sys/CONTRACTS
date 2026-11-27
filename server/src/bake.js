import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { coverDetails, coverTokens, stampContractDates, stampCoverDetails, ukDate } from "./coverStamp.js";
import { addBrandedBackCover, addBrandedCover, brokerLegalName, packTheme } from "./packLayout.js";
import { db, newId, now, sha256, parseJson } from "./db.js";
import { appendEvent } from "./events.js";
import { readBytes, writeBytes } from "./storage.js";
import { snapshotEnvelopeFields, envelopePlacedFields, prefillPartyFields } from "./documentFields.js";
import { PARTY_LABELS } from "./parties.js";
import { buildWordContract } from "./wordContract.js";

async function loadOrCreateSourcePdf(template) {
  let bytes;
  if (template.source_url.startsWith("local://")) {
    bytes = readBytes(template.source_url.replace("local://", ""));
  } else {
    const doc = await PDFDocument.create();
    const page = doc.addPage([595.28, 841.89]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText(template.name, { x: 50, y: 780, size: 18, font });
    page.drawText("Local snapshot (source URL not fetched in local mode).", {
      x: 50,
      y: 750,
      size: 11,
      font,
    });
    bytes = Buffer.from(await doc.save());
  }
  return bytes;
}

function isSvgAsset(asset) {
  const mime = String(asset?.mime || "").toLowerCase();
  const ref = String(asset?.storage_ref || "").toLowerCase();
  const name = String(asset?.name || "").toLowerCase();
  return mime.includes("svg") || ref.endsWith(".svg") || name.endsWith(".svg");
}

function isPngAsset(asset) {
  const mime = String(asset?.mime || "").toLowerCase();
  const ref = String(asset?.storage_ref || "").toLowerCase();
  const name = String(asset?.name || "").toLowerCase();
  return mime.includes("png") || ref.endsWith(".png") || name.endsWith(".png");
}

async function svgToPngBytes(svgBytes) {
  const { Resvg } = await import("@resvg/resvg-js");
  const resvg = new Resvg(svgBytes, { fitTo: { mode: "width", value: 280 } });
  return resvg.render().asPng();
}

export async function embedLogoImage(bakedDoc, asset) {
  const logoBytes = readBytes(asset.storage_ref);
  if (isSvgAsset(asset)) {
    return bakedDoc.embedPng(await svgToPngBytes(logoBytes));
  }
  if (isPngAsset(asset)) {
    return bakedDoc.embedPng(logoBytes);
  }
  return bakedDoc.embedJpg(logoBytes);
}

async function pdfFromAsset(asset) {
  if (!asset) return null;
  const bytes = readBytes(asset.storage_ref);
  if ((asset.mime || "").includes("pdf") || asset.storage_ref.endsWith(".pdf")) {
    return PDFDocument.load(bytes);
  }
  // PNG/JPEG cover → single A4 page
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]);
  let image;
  if ((asset.mime || "").includes("png") || asset.storage_ref.endsWith(".png")) {
    image = await doc.embedPng(bytes);
  } else {
    image = await doc.embedJpg(bytes);
  }
  const { width, height } = page.getSize();
  page.drawImage(image, { x: 0, y: 0, width, height });
  return doc;
}

function activeAsset(entityId, kind) {
  return db
    .prepare(
      `SELECT * FROM entity_assets
       WHERE entity_id = ? AND kind = ? AND is_active = 1
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(entityId, kind);
}

export function listAppendices({ industry, entityId, ids } = {}) {
  if (Array.isArray(ids)) {
    if (!ids.length) return [];
    return db
      .prepare(
        `SELECT * FROM appendices
         WHERE is_active = 1 AND id IN (${ids.map(() => "?").join(",")})
         ORDER BY industry, name`
      )
      .all(...ids);
  }
  if (industry) {
    return db
      .prepare(
        `SELECT * FROM appendices
         WHERE is_active = 1
           AND industry = ?
           AND (entity_id IS NULL OR entity_id = ? OR ? IS NULL)
         ORDER BY name ASC`
      )
      .all(industry, entityId || null, entityId || null);
  }
  return db
    .prepare(`SELECT * FROM appendices WHERE is_active = 1 ORDER BY industry, name`)
    .all();
}

export function resolveBrandPack(entityId, { industry = null, appendixIds = [] } = {}) {
  // Covers/logo always come from the sending company's setup (active assets).
  const front = activeAsset(entityId, "front_cover");
  const back = activeAsset(entityId, "back_cover");
  const logo = activeAsset(entityId, "logo");
  const appendices = listAppendices({ ids: appendixIds, industry, entityId });
  return { front, back, logo, industry: industry || null, appendices };
}

/** The shared placeholder contract, used for a broker that has no contract of its own of that type. */
export function getMasterTemplate({ includeInactive = false } = {}) {
  if (includeInactive) {
    return db
      .prepare(
        `SELECT * FROM templates
         WHERE is_master = 1 AND entity_id IS NULL
         ORDER BY is_active DESC, created_at ASC LIMIT 1`
      )
      .get();
  }
  return (
    db
      .prepare(
        `SELECT * FROM templates
         WHERE is_master = 1 AND is_active = 1 AND entity_id IS NULL
         ORDER BY created_at ASC LIMIT 1`
      )
      .get() ||
    db
      .prepare(
        `SELECT * FROM templates
         WHERE is_active = 1 AND entity_id IS NULL AND party_shape IS NULL
         ORDER BY created_at ASC LIMIT 1`
      )
      .get()
  );
}

/** `issuedOn` fills a Word contract's issue date; it is given when the contract is sent. */
/** Word fields keep the same id across bakes, so values entered before a re-bake stay with their box. */
function wordFieldIds(fields) {
  const seen = new Map();
  return fields.map((field) => {
    const count = (seen.get(field.field_key) || 0) + 1;
    seen.set(field.field_key, count);
    return { ...field, id: `word-${field.field_key}${count > 1 ? `-${count}` : ""}` };
  });
}

/** `issuedOn` fills a Word contract's issue date; it is given when the contract is sent. */
export async function bakeEnvelope(envelopeId, { actor = "system", issuedOn = null } = {}) {
  const envelope = db.prepare("SELECT * FROM envelopes WHERE id = ?").get(envelopeId);
  if (!envelope)     throw new Error("Contract not found");
  if (!["draft", "baking", "ready"].includes(envelope.status)) {
    throw new Error("A contract can only be baked before it is sent");
  }

  db.prepare(
    "UPDATE envelopes SET status = 'baking', bake_error = NULL WHERE id = ?"
  ).run(envelopeId);

  try {
    const entity = db.prepare("SELECT * FROM entities WHERE id = ?").get(envelope.entity_id);
    if (!entity) throw new Error("Broker not found");

    const parties = db
      .prepare(
        `SELECT p.*, r.role_key, r.signing_order
         FROM envelope_parties p
         JOIN template_roles r ON r.id = p.role_id
         WHERE p.envelope_id = ?
         ORDER BY p.order_index ASC`
      )
      .all(envelopeId);
    const expected = envelope.party_shape === "four" ? 4 : 3;
    if (parties.length !== expected) {
      throw new Error(
        expected === 4
          ? "All four parties (Contractor, Supplier, Broker, Client) must be assigned"
          : "All three parties (Contractor, Broker, Client) must be assigned"
      );
    }

    const templateId =
      envelope.template_id ||
      db.prepare("SELECT template_id FROM template_roles WHERE id = ?").get(parties[0].role_id)
        ?.template_id;
    const template = db.prepare("SELECT * FROM templates WHERE id = ?").get(templateId);
    if (!template) throw new Error("Template missing");

    const fields = db
      .prepare("SELECT * FROM template_fields WHERE template_id = ?")
      .all(template.id);
    if (fields.some((f) => f.x == null || f.y == null)) {
      throw new Error("All role fields must have positions");
    }

    const appendixIds = parseJson(envelope.appendix_ids_json, []);
    const brand = resolveBrandPack(entity.id, {
      industry: envelope.industry || template.industry || null,
      appendixIds,
    });
    // A Word contract is filled from the records and carries its own covers and signing boxes.
    const word = Boolean(template.docx_ref);
    const sourceBytes = word ? readBytes(template.docx_ref) : await loadOrCreateSourcePdf(template);
    const contentHash = sha256(sourceBytes);

    let version = db
      .prepare(
        "SELECT * FROM template_versions WHERE template_id = ? AND content_hash = ?"
      )
      .get(template.id, contentHash);

    if (!version) {
      const snap = writeBytes(
        "snapshots",
        `${template.id}-${contentHash.slice(0, 12)}.${word ? "docx" : "pdf"}`,
        sourceBytes
      );
      const versionNo =
        (db
          .prepare(
            "SELECT COALESCE(MAX(version_no), 0) AS m FROM template_versions WHERE template_id = ?"
          )
          .get(template.id)?.m || 0) + 1;
      version = {
        id: newId(),
        template_id: template.id,
        version_no: versionNo,
        content_hash: contentHash,
        storage_ref: snap.storageRef,
        fetched_at: now(),
      };
      db.prepare(
        `INSERT INTO template_versions (
          id, template_id, version_no, content_hash, storage_ref, fetched_at
        ) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        version.id,
        version.template_id,
        version.version_no,
        version.content_hash,
        version.storage_ref,
        version.fetched_at
      );
    }

    // Assemble: front cover + contract + industry appendices + back cover
    const bakedDoc = await PDFDocument.create();
    const font = await bakedDoc.embedFont(StandardFonts.Helvetica);
    const bold = await bakedDoc.embedFont(StandardFonts.HelveticaBold);

    const details = coverDetails(
      envelope,
      Object.fromEntries(parties.map((party) => [party.role_key, party])),
      entity,
      "Contract"
    );
    const brokerName = entity.display_name || "the broker";
    const brokerLegal = brokerLegalName(entity) || brokerName;
    const coverFill = {
      tokens: coverTokens(details, entity, {
        brokerLegal,
        document: template.name,
        prepared: envelope.prepared_on ? ukDate(envelope.prepared_on) : "",
      }),
      rows: [
        ["Client", details.client || "—"],
        ["Contractor", details.contractor || "—"],
        ...(details.supplier ? [["Supplier", details.supplier]] : []),
        ["Broker", brokerLegal],
        ["Reference", details.reference, true],
        ["Dated", "Date of last signature"],
      ],
    };
    const built = word
      ? await buildWordContract({ envelope, template: { ...template, docx_ref: version.storage_ref }, entity, issuedOn })
      : null;
    const frontDoc = word ? null : await pdfFromAsset(brand.front);
    if (frontDoc) {
      const branded = await addBrandedCover(
        bakedDoc,
        brand.front,
        { font, bold, theme: packTheme(entity) },
        {
          brand: brokerName.toUpperCase(),
          packTitle: template.name,
          forUse: `${details.version} contract`,
          parties: [
            ["Contractor", details.contractor || "—"],
            ...(details.supplier ? [["Supplier", details.supplier]] : []),
            ["Client", details.client || "—"],
          ],
          legal: [
            brokerLegal,
            ...(entity.company_number ? [`Company number ${entity.company_number}`] : []),
            ...(entity.registered_office ? [`Registered office: ${entity.registered_office}`] : []),
          ],
          meta: [
            ["Prepared", envelope.prepared_on ? ukDate(envelope.prepared_on) : "—"],
            ["Doc ID", details.reference],
          ],
          fill: coverFill,
        }
      );
      const indices = frontDoc.getPageIndices().slice(branded ? 1 : 0);
      const pages = await bakedDoc.copyPages(frontDoc, indices);
      pages.forEach((p) => bakedDoc.addPage(p));
      if (!branded) stampCoverDetails(bakedDoc.getPages()[0], font, bold, details);
    }

    const contractDoc = await PDFDocument.load(word ? built.pdf : readBytes(version.storage_ref));
    const contractPages = await bakedDoc.copyPages(
      contractDoc,
      contractDoc.getPageIndices()
    );
    // People read the contract and its schedules, then sign: the contract's pages with
    // signature fields come after the schedules, just before the back cover. A Word contract
    // keeps its own back pages, so its schedules go in before its first signing page.
    const contractFields = word ? built.fields : fields;
    const signingPages = new Set(
      contractFields.filter((f) => f.field_type === "signature").map((f) => Number(f.page || 0))
    );
    if (word && signingPages.size) {
      const first = Math.min(...signingPages);
      contractPages.forEach((_, index) => {
        if (index > first) signingPages.add(index);
      });
    }
    const masterPageMap = [];
    const placeContractPages = (wanted) =>
      contractPages.forEach((page, index) => {
        if (!wanted(index)) return;
        masterPageMap[index] = bakedDoc.getPageCount();
        bakedDoc.addPage(page);
      });
    placeContractPages((index) => !signingPages.has(index));

    const appendixStarts = [];
    for (const appendix of brand.appendices) {
      const appendixDoc = await PDFDocument.load(readBytes(appendix.storage_ref));
      const pageIndex = bakedDoc.getPageCount();
      const pages = await bakedDoc.copyPages(appendixDoc, appendixDoc.getPageIndices());
      pages.forEach((p) => bakedDoc.addPage(p));
      appendixStarts.push({ id: appendix.id, pageIndex });
    }

    placeContractPages((index) => signingPages.has(index));
    const contractPageOffset = masterPageMap[0];

    // The shared placeholder gets the broker's legal footer and logo; a broker's own contract
    // already carries its branding, and a second logo would sit on top of it.
    const firstContract = template.entity_id === entity.id ? null : bakedDoc.getPages()[contractPageOffset];
    if (firstContract) {
      const legal = `${entity.legal_name} · ${entity.company_number} · ${entity.registered_office}`;
      const room = firstContract.getWidth() - 80;
      firstContract.drawText(legal, {
        x: 40,
        y: 28,
        size: Math.max(5.5, Math.min(8, (8 * room) / font.widthOfTextAtSize(legal, 8))),
        font,
        color: rgb(0.25, 0.25, 0.25),
      });
      if (brand.logo) {
        try {
          const logoImage = await embedLogoImage(bakedDoc, brand.logo);
          const scale = Math.min(70 / logoImage.width, 28 / logoImage.height);
          const width = logoImage.width * scale;
          const height = logoImage.height * scale;
          firstContract.drawImage(logoImage, {
            x: 550 - width,
            y: 780 + (28 - height) / 2,
            width,
            height,
          });
        } catch {
          /* logo optional */
        }
      }
    }

    if (brand.back && !word) {
      await addBrandedBackCover(
        bakedDoc,
        brand.back,
        { font, bold, theme: packTheme(entity) },
        {
          name: brokerLegalName(entity),
          companyNumber: entity.company_number || "",
          registeredOffice: entity.registered_office || "",
        },
        coverFill
      );
    }

    const usesPack = ["three", "four"].includes(envelope.party_shape);
    const signedPack = usesPack && envelope.dd_validated_at && envelope.dd_storage_ref;
    if (signedPack) {
      const packDoc = await PDFDocument.load(readBytes(envelope.dd_storage_ref));
      const pages = await bakedDoc.copyPages(packDoc, packDoc.getPageIndices());
      pages.forEach((p) => bakedDoc.addPage(p));
    }

    // If somehow empty, keep contract only
    if (bakedDoc.getPageCount() === 0) {
      throw new Error("Bake produced an empty document");
    }

    snapshotEnvelopeFields(envelopeId, {
      contractPageOffset,
      masterPageMap,
      appendixStarts,
      contractFields: word ? wordFieldIds(built.fields) : null,
    });
    prefillPartyFields(envelopeId);

    const placedFields = envelopePlacedFields(envelopeId);
    const unsigned = parties.filter(
      (party) =>
        !placedFields.some((field) => field.role_id === party.role_id && field.field_type === "signature")
    );
    if (unsigned.length) {
      const names = unsigned.map((party) => PARTY_LABELS[party.role_key] || party.role_key).join(", ");
      throw new Error(
        `The master contract has no signature field for: ${names}. Replace the master contract with one that names each party, then bake again.`
      );
    }
    // The signed copy is stamped onto this one, so it carries no field boxes or captions,
    // and its issue date is added when it is signed.
    const cleanBytes = Buffer.from(await bakedDoc.save());
    const cleanFile = writeBytes("baked", `${envelopeId}-clean.pdf`, cleanBytes);
    // pdf-lib caches page content on save, so anything drawn on bakedDoc from here on would be lost.
    const previewDoc = await PDFDocument.load(cleanBytes);
    const previewFont = await previewDoc.embedFont(StandardFonts.Helvetica);
    const previewPages = previewDoc.getPages();
    if (!word && previewPages[contractPageOffset]) stampContractDates(previewPages[contractPageOffset], previewFont, envelope);
    const partyRoles = new Map(parties.map((party) => [party.role_id, PARTY_LABELS[party.role_key] || party.role_key]));
    for (const field of placedFields.filter((f) => partyRoles.has(f.role_id))) {
      // A contract's own labels ("Date:") rarely say whose box it is.
      const label = String(field.label || field.field_key).replace(/:\s*$/, "");
      const party = partyRoles.get(field.role_id);
      const caption = /\b(contractor|supplier|spv|broker|agency|client)\b/i.test(label) ? label : `${party}: ${label}`;
      const page = previewPages[Math.min(Number(field.page || 0), previewPages.length - 1)];
      const x = Number(field.x);
      const y = Number(field.y);
      const w = Number(field.w);
      const h = Number(field.h);
      page.drawRectangle({
        x,
        y,
        width: w,
        height: h,
        borderColor: rgb(0.05, 0.45, 0.42),
        borderWidth: 1,
        color: rgb(0.85, 0.95, 0.93),
        opacity: 0.35,
        borderOpacity: 0.9,
      });
      page.drawText(caption, {
        x: x + 3,
        y: y + Math.max(h - 10, 2),
        size: 8,
        font: previewFont,
        color: rgb(0.05, 0.35, 0.32),
      });
    }

    void bold;
    const bakedBytes = Buffer.from(await previewDoc.save());
    const bakedFile = writeBytes("baked", `${envelopeId}-baked.pdf`, bakedBytes);

    const docId = newId();
    db.prepare(
      `INSERT INTO documents (id, envelope_id, kind, storage_ref, sha256, size_bytes, created_at)
       VALUES (?, ?, 'baked', ?, ?, ?, ?)`
    ).run(
      docId,
      envelopeId,
      bakedFile.storageRef,
      bakedFile.sha256,
      bakedFile.sizeBytes,
      now()
    );

    db.prepare(
      `UPDATE envelopes SET
        status = 'ready',
        template_id = ?,
        template_version_id = ?,
        baked_document_id = ?,
        baked_hash = ?,
        front_cover_id = ?,
        back_cover_id = ?,
        logo_asset_id = ?,
        industry = ?,
        appendix_ids_json = ?,
        contract_page_offset = ?,
        baked_dd_sha256 = ?,
        baked_clean_ref = ?,
        word_contract = ?,
        bake_error = NULL
       WHERE id = ?`
    ).run(
      template.id,
      version.id,
      docId,
      bakedFile.sha256,
      brand.front?.id || null,
      brand.back?.id || null,
      brand.logo?.id || null,
      brand.industry || envelope.industry || null,
      JSON.stringify(brand.appendices.map((a) => a.id)),
      contractPageOffset,
      signedPack ? envelope.dd_sha256 : null,
      cleanFile.storageRef,
      word ? 1 : 0,
      envelopeId
    );

    appendEvent({
      envelopeId,
      actor,
      eventType: "envelope_baked",
      metadata: {
        baked_hash: bakedFile.sha256,
        template_version_id: version.id,
        document_id: docId,
        front_cover_id: brand.front?.id || null,
        back_cover_id: brand.back?.id || null,
        logo_asset_id: brand.logo?.id || null,
        appendix_ids: brand.appendices.map((a) => a.id),
        prepared_on: envelope.prepared_on || null,
        due_diligence_pack_hash: signedPack ? envelope.dd_sha256 : null,
      },
    });

    return db.prepare("SELECT * FROM envelopes WHERE id = ?").get(envelopeId);
  } catch (err) {
    db.prepare(
      "UPDATE envelopes SET status = 'draft', bake_error = ? WHERE id = ?"
    ).run(err.message || "Bake failed", envelopeId);
    throw err;
  }
}

/** At issue: a Word contract is filled again with its issue date; any other carries the pack as last signed. */
export async function bakeForIssue(envelopeId, { actor = "staff", issuedOn }) {
  const envelope = db.prepare("SELECT status, word_contract FROM envelopes WHERE id = ?").get(envelopeId);
  if (envelope?.status === "ready" && envelope.word_contract) {
    await bakeEnvelope(envelopeId, { actor, issuedOn });
    return true;
  }
  return bakeInSignedPack(envelopeId, { actor });
}

/** The signed pack travels with the contract, so an issue must carry the pack as last signed. */
export async function bakeInSignedPack(envelopeId, { actor = "staff" } = {}) {
  const envelope = db.prepare("SELECT * FROM envelopes WHERE id = ?").get(envelopeId);
  if (envelope?.status !== "ready" || !envelope.dd_validated_at) return false;
  if (envelope.baked_dd_sha256 === envelope.dd_sha256 && envelope.baked_clean_ref) return false;
  await bakeEnvelope(envelopeId, { actor });
  return true;
}

export { parseJson };

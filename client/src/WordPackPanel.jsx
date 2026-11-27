import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "./api.js";
import SaveProgressBar from "./SaveProgressBar.jsx";

const ROW_NAMES = { directors: "Director", pscs: "PSC", paye_schemes: "PAYE scheme" };
const FIXED_LABELS = [
  ["contractor.legal_name", "Contractor"],
  ["pack.client_names", "Client"],
  ["pack.payment_models", "Payment models"],
  ["pack.reference", "Pack reference"],
];

const atRow = (path, index) => path.replace(/\[\]/g, `[${index}]`);
const normal = (value) => (value === false || value == null ? "" : typeof value === "string" ? value.trim() : value);
const same = (a, b) => normal(a) === normal(b);
const isFile = (field) => field.kind === "upload" || field.kind === "image";
const rowName = (group) => ROW_NAMES[group.split(".").pop()] || "Row";

/** "contractor.chain_entities[].vat_result" → "VAT result", for a field the template doesn't caption. */
function fieldName(path) {
  const words = path
    .split(".")
    .pop()
    .replace(/\[\]$/, "")
    .replace(/_/g, " ")
    .replace(/\b(vat|ern|paye|ao|utr|ico|hmrc|cis|psc|ubo|uk|fps)\b/g, (word) => word.toUpperCase());
  return words.charAt(0).toUpperCase() + words.slice(1);
}
const blockFields = (block) =>
  block.type === "check" ? [{ kind: "check", path: block.path }] : block.type === "record" ? block.rows.flatMap((row) => row.fields) : block.fields || [];

/** The broker's own Parts A–K pack on a 3-way contract: staff fill it here, compile it, then the broker signs Part K. */
export default function WordPackPanel({ envelopeId, pack, busy, run }) {
  const navigate = useNavigate();
  const [values, setValues] = useState({});
  const [counts, setCounts] = useState({});
  const [signedOn, setSignedOn] = useState(null);
  const locked = pack.locked;
  const today = localToday();

  const valueOf = (key) => (key in values ? values[key] : pack.values[key]);
  const countOf = (group) => counts[group] ?? pack.counts[group] ?? 0;
  const setValue = (key, value) => setValues((current) => ({ ...current, [key]: value }));
  const conditionMet = (block) => !block.condition || block.condition !== "engagement.cis_in_scope" || pack.cisInScope;

  const changedValues = Object.fromEntries(Object.entries(values).filter(([key, value]) => !same(value, pack.values[key])));
  const changedCounts = Object.fromEntries(Object.entries(counts).filter(([group, count]) => count !== (pack.counts[group] ?? 0)));
  const certificateDate = signedOn ?? pack.certificate.signedOn ?? "";
  const dateChanged = signedOn !== null && signedOn !== (pack.certificate.signedOn || "");
  const dirty = !locked && Boolean(Object.keys(changedValues).length || Object.keys(changedCounts).length || dateChanged);

  async function save() {
    await api.saveWordPack(envelopeId, {
      values: changedValues,
      counts: changedCounts,
      ...(dateChanged ? { signedOn } : {}),
    });
  }

  function filled(section) {
    let done = 0;
    let total = 0;
    for (const block of section.blocks) {
      if (!conditionMet(block) || block.type === "heading" || block.type === "note") continue;
      const rows = block.group ? countOf(block.group) : 1;
      for (let index = 0; index < rows; index += 1) {
        for (const field of blockFields(block)) {
          const key = block.group ? atRow(field.path, index) : field.path;
          total += 1;
          if (isFile(field) ? pack.files[key]?.length : normal(valueOf(key)) !== "") done += 1;
        }
      }
    }
    return { done, total };
  }

  const fieldProps = (key) => ({
    value: valueOf(key),
    onChange: (value) => setValue(key, value),
    files: pack.files[key] || [],
    onUpload: (file) => run(`pack-file-${key}`, () => api.uploadWordPackFile(envelopeId, key, file)),
    onRemove: (fileId) => run(`pack-file-${key}`, () => api.deleteWordPackFile(envelopeId, fileId)),
    envelopeId,
    fromRecords: pack.fromRecords.includes(key),
  });

  function renderRow(row, keyFor, disabled, rowKey) {
    const single = row.fields.length === 1 && !row.fields[0].caption;
    if (single) {
      const field = row.fields[0];
      const wide = field.type === "long" || isFile(field) || field.kind === "check" || row.label.length > 60;
      return (
        <PackField
          key={rowKey}
          field={field}
          label={row.label}
          wide={wide}
          disabled={disabled}
          {...fieldProps(keyFor(field.path))}
        />
      );
    }
    return (
      <div key={rowKey} className="pack-row pack-wide">
        <strong>{row.label}</strong>
        <div className="signer-row">
          {row.fields.map((field) => (
            <PackField
              key={field.path}
              field={field}
              label={field.caption || fieldName(field.path)}
              disabled={disabled}
              {...fieldProps(keyFor(field.path))}
            />
          ))}
        </div>
      </div>
    );
  }

  function repeatControls(group, count, noun, disabled) {
    return (
      <div className="toolbar" style={{ margin: 0 }}>
        <button
          type="button"
          className="btn secondary"
          disabled={disabled || count >= 50}
          onClick={() => setCounts((current) => ({ ...current, [group]: count + 1 }))}
        >
          Add {noun.toLowerCase()}
        </button>
        {count ? (
          <button
            type="button"
            className="btn secondary"
            disabled={disabled}
            onClick={() => setCounts((current) => ({ ...current, [group]: count - 1 }))}
          >
            Remove {noun.toLowerCase()} {count}
          </button>
        ) : null}
      </div>
    );
  }

  function renderBlock(block, index) {
    const disabled = locked || Boolean(busy) || !conditionMet(block);
    const own = (path) => path;
    if (block.type === "heading") return <h4 key={index} className="pack-wide">{block.text}</h4>;
    if (block.type === "note") return <p key={index} className="muted pack-wide">{block.text}</p>;
    if (block.type === "check") {
      return (
        <label key={index} className="consent pack-wide">
          <input
            type="checkbox"
            checked={Boolean(valueOf(block.path))}
            disabled={disabled}
            onChange={(e) => setValue(block.path, e.target.checked)}
          />
          <span>{block.label}</span>
        </label>
      );
    }
    if (block.type === "row") return renderRow(block, own, disabled, index);
    if (block.type === "table") {
      const count = countOf(block.group);
      const noun = rowName(block.group);
      return (
        <div key={index} className="pack-repeat pack-wide">
          {Array.from({ length: count }, (_, row) => (
            <div key={row} className="pack-row">
              <strong>
                {noun} {row + 1}
              </strong>
              <div className="signer-row">
                {block.fields.map((field) => (
                  <PackField
                    key={field.path}
                    field={field}
                    label={field.caption || noun}
                    disabled={disabled}
                    {...fieldProps(atRow(field.path, row))}
                  />
                ))}
              </div>
            </div>
          ))}
          {count ? null : <p className="muted">None listed.</p>}
          {locked ? null : repeatControls(block.group, count, noun, disabled)}
        </div>
      );
    }
    if (block.type === "record") {
      const count = countOf(block.group);
      return (
        <div key={index} className="pack-repeat pack-wide">
          {Array.from({ length: count }, (_, row) => (
            <div key={row} className="party-card pack-record">
              <h4 className="pack-wide" style={{ margin: 0 }}>
                {block.title} {row + 1}
              </h4>
              {block.rows.map((line, at) => renderRow(line, (path) => atRow(path, row), disabled, at))}
            </div>
          ))}
          {count ? null : <p className="muted">None listed.</p>}
          {locked ? null : repeatControls(block.group, count, block.title, disabled)}
        </div>
      );
    }
    return null;
  }

  const certificate = pack.certificate;
  const partK = pack.sections.findIndex((section) => section.key === "K");
  const certificateCard = (
    <div className="party-card" key="part-j">
      <h3 style={{ margin: 0 }}>Part J — Director’s certificate</h3>
      <p className="meta">
        Signed with {certificate.name || "the contractor’s signatory"}’s saved signature
        {certificate.company ? ` (${certificate.position}, ${certificate.company})` : ""} when the pack is compiled.
        {certificate.recordId ? (
          <>
            {" "}
            <Link to={`/contractors/${certificate.recordId}`}>Open the record</Link>
          </>
        ) : null}
      </p>
      {certificate.officer === false ? (
        <p className="error">{certificate.name} is not a current officer of {certificate.company} at Companies House.</p>
      ) : null}
      <label>
        Date signed
        <input
          type="date"
          value={certificateDate}
          max={today}
          disabled={locked || Boolean(busy)}
          onChange={(e) => setSignedOn(e.target.value)}
        />
      </label>
      {!certificateDate ? <p className="muted">Left blank, it is dated the day the pack is compiled.</p> : null}
    </div>
  );

  return (
    <section className="panel" style={{ marginBottom: "1.25rem" }}>
      <h2>Due diligence pack</h2>
      <p className="muted">
        {pack.template?.file_name ? `${pack.template.file_name}. ` : ""}Fill each Part, compile, then the broker signs Part K.
      </p>
      {pack.validatedAt ? (
        <p className="meta">
          Broker signed {new Date(pack.validatedAt).toLocaleString("en-GB")}
          {pack.signedName ? ` · ${pack.signedName}` : ""}.
        </p>
      ) : pack.compiledAt ? (
        <p className="meta">Compiled {new Date(pack.compiledAt).toLocaleString("en-GB")}. Waiting for the broker to sign.</p>
      ) : (
        <p className="meta">Not compiled yet.</p>
      )}
      <p className="meta">
        {FIXED_LABELS.filter(([key]) => pack.fixed?.[key])
          .map(([key, label]) => `${label}: ${pack.fixed[key]}`)
          .join(" · ")}
      </p>

      <div className="form-grid">
        {pack.sections.map((section, index) => {
          const { done, total } = filled(section);
          const outOfScope = section.blocks.some((block) => !conditionMet(block));
          return [
            index === partK ? certificateCard : null,
            <details key={section.key} className="pack-part">
              <summary>
                <span>{section.title}</span>
                <span className="meta">{outOfScope && !done ? "Not in scope" : `${done} of ${total} filled`}</span>
              </summary>
              <div className="pack-part-body">
                {outOfScope ? (
                  <p className="muted pack-wide">
                    Only for contracts with PAYE and CIS. This contract is PAYE only, so the pack leaves it out.
                  </p>
                ) : null}
                {section.blocks.map(renderBlock)}
              </div>
            </details>,
          ];
        })}
        {partK < 0 ? certificateCard : null}
      </div>

      {pack.compileBlockers?.length && !pack.compiledAt ? (
        <ul className="audit-list" style={{ marginTop: "1rem" }}>
          {pack.compileBlockers.map((item) => (
            <li key={item}>
              <strong>Before compiling</strong>
              <span>{item}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {pack.blockers?.length && !pack.validatedAt ? (
        <ul className="audit-list" style={{ marginTop: "1rem" }}>
          {pack.blockers.map((item) => (
            <li key={item}>
              <strong>Before signing</strong>
              <span>{item}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="toolbar" style={{ marginTop: "1rem" }}>
        <button
          type="button"
          className="btn"
          disabled={Boolean(busy) || !pack.readyToCompile || Boolean(pack.validatedAt) || locked}
          onClick={() =>
            run("compile", async () => {
              if (dirty) await save();
              await api.compileDueDiligence(envelopeId);
            })
          }
        >
          {busy === "compile" ? "Compiling…" : pack.compiledAt ? "Compile again" : "Compile the pack"}
        </button>
        {pack.hasFile && !pack.validatedAt ? (
          <button
            type="button"
            className="btn secondary"
            disabled={Boolean(busy) || Boolean(pack.blockers?.length) || dirty}
            onClick={() =>
              run("sign", async () => {
                const result = await api.dueDiligenceSignLink(envelopeId);
                navigate(result.path);
              })
            }
          >
            {busy === "sign" ? "Opening…" : "Sign the pack"}
          </button>
        ) : null}
        {pack.hasFile ? (
          <a className="btn secondary" href={api.dueDiligenceUrl(envelopeId)} target="_blank" rel="noreferrer">
            Open due diligence pack
          </a>
        ) : null}
      </div>
      <p className="muted">
        {pack.validatedAt
          ? "The client gets the signed pack as its own PDF with the completed contract."
          : "Send stays unavailable until the broker has signed this pack. Any change after compiling means compiling again."}
      </p>
      {!locked ? <SaveProgressBar dirty={dirty} saving={busy === "pack-save"} onSave={() => run("pack-save", save)} /> : null}
    </section>
  );
}

function PackField({ field, label, wide, value, onChange, disabled, files, onUpload, onRemove, envelopeId, fromRecords }) {
  const className = wide ? "pack-wide" : undefined;
  if (isFile(field)) {
    return (
      <PackFiles
        className={className}
        label={label}
        files={files}
        disabled={disabled}
        onUpload={onUpload}
        onRemove={onRemove}
        envelopeId={envelopeId}
      />
    );
  }
  if (field.kind === "check") {
    return (
      <label className={`consent${wide ? " pack-wide" : ""}`}>
        <input type="checkbox" checked={Boolean(value)} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        <span>
          {label}
          {field.hint ? `: ${field.hint}` : ""}
        </span>
      </label>
    );
  }
  const caption = (
    <span>
      {label}
      {fromRecords && normal(value) !== "" ? <span className="pack-source"> · from the records</span> : null}
    </span>
  );
  if (field.kind === "yn") {
    return (
      <label className={className}>
        {caption}
        <select value={value || ""} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
          <option value="">—</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </select>
      </label>
    );
  }
  if (field.kind === "select") {
    return (
      <label className={className}>
        {caption}
        <select value={value || ""} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
          <option value="">—</option>
          {field.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (field.type === "long") {
    return (
      <label className={className}>
        {caption}
        <textarea rows={2} value={value || ""} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
      </label>
    );
  }
  return (
    <label className={className}>
      {caption}
      <input
        type={field.type === "date" ? "date" : "text"}
        value={value || ""}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function PackFiles({ className, label, files, disabled, onUpload, onRemove, envelopeId }) {
  const inputRef = useRef(null);
  const own = files.filter((file) => file.source === "pack");
  return (
    <div className={`pack-files${className ? ` ${className}` : ""}`}>
      <span className="pack-files-label">{label}</span>
      {files.map((file) =>
        file.source === "record" ? (
          <p key={file.id} className="meta">
            <a href={api.partyFileUrl(file.party_id, file.id)} target="_blank" rel="noreferrer">
              {file.label || file.original_name}
            </a>{" "}
            · on the contractor’s record
          </p>
        ) : (
          <p key={file.id} className="meta">
            <a href={api.wordPackFileUrl(envelopeId, file.id)} target="_blank" rel="noreferrer">
              {file.original_name}
            </a>
            {disabled ? null : (
              <>
                {" "}
                <button type="button" className="link-button" onClick={() => onRemove(file.id)}>
                  Remove
                </button>
              </>
            )}
          </p>
        )
      )}
      {files.length ? null : <p className="muted">Nothing attached.</p>}
      {disabled ? null : (
        <>
          <button type="button" className="btn secondary" onClick={() => inputRef.current?.click()}>
            {own.length ? "Add another" : files.length ? "Upload instead" : "Upload"}
          </button>
          <input
            ref={inputRef}
            className="file-slot-input"
            type="file"
            accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) onUpload(file);
            }}
          />
        </>
      )}
    </div>
  );
}

function localToday() {
  const day = new Date();
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
}

import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api.js";
import ConfirmDialog from "../ConfirmDialog.jsx";
import FileSlot from "../FileSlot.jsx";

export default function Templates() {
  const [master, setMaster] = useState(null);
  const [appendices, setAppendices] = useState([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [masterMeta, setMasterMeta] = useState({ name: "", description: "" });
  const [adding, setAdding] = useState(false);
  const [newAppendix, setNewAppendix] = useState({
    name: "",
    industry: "construction",
    description: "",
  });
  const [pending, setPending] = useState(null);

  async function reload() {
    const [m, apps] = await Promise.all([api.getMasterTemplate(), api.listAppendices()]);
    setMaster(m);
    setMasterMeta({
      name: m?.name || "",
      description: m?.description || "",
    });
    setAppendices(apps);
  }

  useEffect(() => {
    reload().catch((err) => setError(err.message));
  }, []);

  const byIndustry = useMemo(() => {
    const map = new Map();
    for (const a of appendices) {
      if (!map.has(a.industry)) map.set(a.industry, []);
      map.get(a.industry).push(a);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [appendices]);

  async function run(label, fn) {
    setBusy(label);
    setError("");
    try {
      await fn();
      await reload();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  async function confirmDelete() {
    if (!pending) return;
    await run(`delete-${pending.kind}`, async () => {
      if (pending.kind === "master") await api.deleteMasterTemplate();
      else await api.deleteAppendix(pending.id);
      setPending(null);
    });
  }

  return (
    <div>
      <section className="hero-panel">
        <h1>Templates</h1>
        <p>
          One master contract is always sent. Contract appendices can be chosen
          on top of it when creating a contract. Open, replace, or delete files
          the same way as company brand files.
        </p>
      </section>
      {error ? <p className="error">{error}</p> : null}

      <section className="panel form-grid" style={{ marginBottom: "1.25rem" }}>
        <h2>Master contract</h2>
        <p className="muted">
          Included on every contract. Upload a PDF to add or replace it. Signing
          fields are detected from the file.
        </p>
        {master ? (
          <div className="signer-row">
            <label>
              Name
              <input
                value={masterMeta.name}
                onChange={(e) => setMasterMeta((m) => ({ ...m, name: e.target.value }))}
                placeholder="Master Services Agreement"
              />
            </label>
            <label>
              Description
              <input
                value={masterMeta.description}
                onChange={(e) =>
                  setMasterMeta((m) => ({ ...m, description: e.target.value }))
                }
                placeholder="Short description of this contract"
              />
            </label>
            <button
              className="btn secondary"
              type="button"
              disabled={!!busy}
              onClick={() =>
                run("save-master", () => api.updateMasterTemplate(masterMeta))
              }
            >
              {busy === "save-master" ? "Saving…" : "Save details"}
            </button>
          </div>
        ) : null}
        <FileSlot
          label="Master PDF"
          fileName={master?.file_name || master?.name}
          mime="application/pdf"
          present={Boolean(master?.id)}
          previewUrl={master ? api.masterFileUrl() : ""}
          accept=".pdf,application/pdf"
          busy={!!busy}
          uploadLabel="Upload master PDF"
          replaceLabel="Replace"
          emptyText="No master contract yet"
          onUpload={(file) =>
            run("upload-master", () =>
              api.uploadMasterTemplate(file, {
                name: masterMeta.name || file.name.replace(/\.pdf$/i, ""),
                description: masterMeta.description,
              })
            )
          }
          onDelete={
            master
              ? () =>
                  setPending({
                    kind: "master",
                    name: master.name,
                  })
              : null
          }
        >
          {master ? (
            <>
              <p className="meta">
                {master.roles?.length || 0} roles · {master.fields?.length || 0} fields
              </p>
              <FieldList
                fields={master.fields}
                roles={master.roles}
                empty="Replace the PDF to detect signature and detail fields."
              />
            </>
          ) : null}
        </FileSlot>
      </section>

      <section className="panel form-grid" style={{ marginBottom: "1.25rem" }}>
        <div className="toolbar" style={{ margin: 0, justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }}>Contract appendices</h2>
          <button className="btn" type="button" onClick={() => setAdding(true)}>
            Add appendix
          </button>
        </div>
        <p className="muted">
          Optional extras chosen when a contract is created. Each file has Open,
          Replace, and Delete — same controls as the master and company files.
        </p>
        {adding ? (
          <>
            <h3>New appendix</h3>
            <p className="muted">
              Name it, pick an industry, then upload the PDF. If that file needs
              signing, fields are detected the same way as the master.
            </p>
            <label>
              Name
              <input
                value={newAppendix.name}
                onChange={(e) => setNewAppendix((a) => ({ ...a, name: e.target.value }))}
                placeholder="Construction H&S Appendix"
              />
            </label>
            <label>
              Industry
              <input
                value={newAppendix.industry}
                onChange={(e) => setNewAppendix((a) => ({ ...a, industry: e.target.value }))}
                placeholder="construction"
              />
            </label>
            <label>
              Description
              <input
                value={newAppendix.description}
                onChange={(e) =>
                  setNewAppendix((a) => ({ ...a, description: e.target.value }))
                }
                placeholder="What this appendix covers"
              />
            </label>
            <div className="toolbar" style={{ margin: 0 }}>
              <button
                className="btn secondary"
                type="button"
                onClick={() => setAdding(false)}
              >
                Cancel
              </button>
              <FilePickerButton
                className="btn"
                disabled={!!busy || !newAppendix.name || !newAppendix.industry}
                accept=".pdf,application/pdf"
                label="Upload PDF"
                onFile={(file) =>
                  run("add-appendix", async () => {
                    await api.createAppendix({ ...newAppendix, file });
                    setNewAppendix({
                      name: "",
                      industry: newAppendix.industry,
                      description: "",
                    });
                    setAdding(false);
                  })
                }
              />
            </div>
          </>
        ) : null}

        {byIndustry.length === 0 && !adding ? (
          <div className="empty">No appendices yet. Use Add appendix to upload one.</div>
        ) : (
          byIndustry.map(([industry, rows]) => (
            <div key={industry}>
              <h3 style={{ textTransform: "capitalize" }}>{industry}</h3>
              <div className="brand-slots template-slots">
                {rows.map((a) => (
                  <AppendixCard
                    key={a.id}
                    appendix={a}
                    busy={busy}
                    onSave={(body) => run(`save-${a.id}`, () => api.updateAppendix(a.id, body))}
                    onReplace={(file) =>
                      run(`file-${a.id}`, () => api.uploadAppendixFile(a.id, file))
                    }
                    onDelete={() =>
                      setPending({ kind: "appendix", id: a.id, name: a.name })
                    }
                  />
                ))}
              </div>
            </div>
          ))
        )}
      </section>

      {pending ? (
        <ConfirmDialog
          title="Are you sure?"
          message={
            pending.kind === "master"
              ? `Delete the master contract (${pending.name})? New contracts cannot be created until you upload another PDF. Existing contracts stay on file.`
              : `Delete ${pending.name}? It will leave the template catalog. Existing contracts stay on file.`
          }
          confirmLabel={
            pending.kind === "master" ? "Yes, delete master" : "Yes, delete appendix"
          }
          busy={Boolean(busy)}
          onCancel={() => (busy ? null : setPending(null))}
          onConfirm={confirmDelete}
        />
      ) : null}
    </div>
  );
}

function AppendixCard({ appendix, busy, onSave, onReplace, onDelete }) {
  const [form, setForm] = useState({
    name: appendix.name,
    industry: appendix.industry,
    description: appendix.description || "",
  });

  useEffect(() => {
    setForm({
      name: appendix.name,
      industry: appendix.industry,
      description: appendix.description || "",
    });
  }, [appendix]);

  return (
    <FileSlot
      label={form.name || "Appendix"}
      fileName={appendix.file_name || appendix.name}
      mime="application/pdf"
      present
      previewUrl={api.appendixFileUrl(appendix.id)}
      accept=".pdf,application/pdf"
      busy={!!busy}
      replaceLabel="Replace"
      emptyText="No PDF"
      onUpload={onReplace}
      onDelete={onDelete}
    >
      <label>
        Name
        <input
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          placeholder="Appendix name"
        />
      </label>
      <label>
        Industry
        <input
          value={form.industry}
          onChange={(e) => setForm((f) => ({ ...f, industry: e.target.value }))}
          placeholder="construction"
        />
      </label>
      <label>
        Description
        <input
          value={form.description}
          onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          placeholder="What this appendix covers"
        />
      </label>
      <button
        className="btn secondary"
        type="button"
        disabled={!!busy}
        onClick={() => onSave(form)}
      >
        Save details
      </button>
      {appendix.needs_signing ? (
        <p className="meta">Needs signing · {appendix.fields?.length || 0} fields</p>
      ) : (
        <p className="muted">No signing fields detected on this appendix.</p>
      )}
      <FieldList fields={appendix.fields} empty="" />
    </FileSlot>
  );
}

function FilePickerButton({ className, disabled, accept, label, onFile }) {
  const inputRef = useRef(null);
  return (
    <>
      <button
        className={className}
        type="button"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >
        {label}
      </button>
      <input
        ref={inputRef}
        className="file-slot-input"
        type="file"
        accept={accept}
        disabled={disabled}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) onFile(file);
        }}
      />
    </>
  );
}

function FieldList({ fields = [], roles = [], empty = "No fields detected." }) {
  const roleById = Object.fromEntries((roles || []).map((role) => [role.id, role]));
  const labels = {
    company: "Client",
    agency: "Broker",
    supplier: "Contractor",
    spv: "Supplier (SPV)",
  };
  if (!fields.length) {
    return empty ? <p className="muted">{empty}</p> : null;
  }
  return (
    <div className="field-list">
      {fields.map((field) => {
        const party =
          labels[field.role_key] || roleById[field.role_id]?.label || "Party";
        return (
          <p className="meta" key={field.id || `${field.field_key}-${field.page}`}>
            {party} · {field.label} · {field.field_type} · page {(field.page || 0) + 1}
          </p>
        );
      })}
    </div>
  );
}

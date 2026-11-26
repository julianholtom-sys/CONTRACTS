import { useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import ConfirmDialog from "./ConfirmDialog.jsx";
import FileSlot from "./FileSlot.jsx";

const SHAPES = [
  ["three", "3-way contract"],
  ["four", "4-way contract"],
];

const USED_ON = [
  ["", "3-way and 4-way"],
  ["three", "3-way only"],
  ["four", "4-way only"],
];

const PARTY = {
  company: "Client",
  agency: "Broker",
  supplier: "Contractor",
  spv: "Supplier (SPV)",
};

export default function BrokerContracts({ entityId, brokerName, heading = "Contracts and schedules" }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: "", shape: "" });
  const [pending, setPending] = useState(null);

  async function reload() {
    setData(await api.brokerContracts(entityId));
  }

  useEffect(() => {
    reload().catch((err) => setError(err.message));
  }, [entityId]);

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
    await run("delete", async () => {
      if (pending.shape) await api.deleteBrokerContract(entityId, pending.shape);
      else await api.deleteAppendix(pending.id);
      setPending(null);
    });
  }

  if (!data) {
    return (
      <section className="panel form-grid">
        <h2>{heading}</h2>
        {error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>}
      </section>
    );
  }

  return (
    <section className="panel form-grid">
      <h2>{heading}</h2>
      <p className="muted">
        A 3-way contract uses the 3-way PDF, a 4-way contract the 4-way PDF. Schedules are ticked when a contract is
        created. Signing fields are found in each file.
      </p>
      {error ? <p className="error">{error}</p> : null}
      <div className="brand-slots template-slots">
        {SHAPES.map(([shape, label]) => (
          <MasterSlot
            key={shape}
            label={label}
            master={data.masters[shape]}
            placeholder={data.placeholder}
            fileUrl={api.brokerContractFileUrl(entityId, shape)}
            busy={Boolean(busy)}
            onUpload={(file, name) =>
              run(`upload-${shape}`, () =>
                api.uploadBrokerContract(entityId, shape, file, {
                  name: name || data.masters[shape]?.name || "Master Services Agreement",
                })
              )
            }
            onRename={(name) => run(`name-${shape}`, () => api.updateBrokerContract(entityId, shape, { name }))}
            onDelete={() => setPending({ shape, name: `${brokerName}’s ${label}` })}
          />
        ))}
      </div>

      <div className="toolbar" style={{ margin: 0, justifyContent: "space-between" }}>
        <h3 style={{ margin: 0 }}>Schedules</h3>
        <button className="btn" type="button" onClick={() => setAdding(true)}>
          Add schedule
        </button>
      </div>
      {adding ? (
        <div className="party-card">
          <div className="signer-row">
            <label>
              Name
              <input
                value={draft.name}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                placeholder="Schedule 1: Assignment details"
              />
            </label>
            <label>
              Used on
              <select value={draft.shape} onChange={(e) => setDraft((d) => ({ ...d, shape: e.target.value }))}>
                {USED_ON.map(([value, text]) => (
                  <option key={value} value={value}>
                    {text}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="toolbar" style={{ margin: 0 }}>
            <button className="btn secondary" type="button" onClick={() => setAdding(false)}>
              Cancel
            </button>
            <FilePickerButton
              className="btn"
              disabled={Boolean(busy) || !draft.name.trim()}
              label="Upload PDF"
              onFile={(file) =>
                run("add-schedule", async () => {
                  await api.addSchedule(entityId, { ...draft, file });
                  setDraft({ name: "", shape: draft.shape });
                  setAdding(false);
                })
              }
            />
          </div>
        </div>
      ) : null}
      {data.schedules.length ? (
        <div className="brand-slots template-slots">
          {data.schedules.map((schedule) => (
            <ScheduleSlot
              key={schedule.id}
              schedule={schedule}
              busy={Boolean(busy)}
              onSave={(body) => run(`save-${schedule.id}`, () => api.updateAppendix(schedule.id, body))}
              onReplace={(file) => run(`file-${schedule.id}`, () => api.uploadAppendixFile(schedule.id, file))}
              onDelete={() => setPending({ id: schedule.id, name: schedule.name })}
            />
          ))}
        </div>
      ) : !adding ? (
        <p className="muted">No schedules yet.</p>
      ) : null}

      {pending ? (
        <ConfirmDialog
          title="Are you sure?"
          message={
            pending.shape
              ? `Delete ${pending.name}? ${
                  data.placeholder ? "New contracts of this shape will use the placeholder until another is uploaded." : "New contracts of this shape cannot be created until another is uploaded."
                } Existing contracts stay on file.`
              : `Delete ${pending.name}? Existing contracts stay on file.`
          }
          confirmLabel={pending.shape ? "Yes, delete contract" : "Yes, delete schedule"}
          busy={Boolean(busy)}
          onCancel={() => (busy ? null : setPending(null))}
          onConfirm={confirmDelete}
        />
      ) : null}
    </section>
  );
}

function MasterSlot({ label, master, placeholder, fileUrl, busy, onUpload, onRename, onDelete }) {
  const [name, setName] = useState(master?.name || "");

  useEffect(() => {
    setName(master?.name || "");
  }, [master?.id, master?.name]);

  return (
    <FileSlot
      label={label}
      fileName={master?.file_name}
      mime="application/pdf"
      present={Boolean(master)}
      previewUrl={master ? fileUrl : ""}
      accept=".pdf,application/pdf"
      busy={busy}
      uploadLabel="Upload PDF"
      emptyText={
        placeholder ? `Not uploaded. The placeholder (${placeholder.name}) is used until it is.` : "Not uploaded."
      }
      onUpload={(file) => onUpload(file, name.trim())}
      onDelete={master ? onDelete : null}
    >
      <label>
        Name in the pack
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Master Services Agreement" />
      </label>
      {master ? (
        <>
          <button
            className="btn secondary"
            type="button"
            disabled={busy || !name.trim() || name.trim() === master.name}
            onClick={() => onRename(name.trim())}
          >
            Save name
          </button>
          <FieldList fields={master.fields} roles={master.roles} empty="No signing fields found. Replace the PDF to try again." />
        </>
      ) : null}
    </FileSlot>
  );
}

function ScheduleSlot({ schedule, busy, onSave, onReplace, onDelete }) {
  const [form, setForm] = useState({ name: schedule.name, shape: schedule.party_shape || "" });

  useEffect(() => {
    setForm({ name: schedule.name, shape: schedule.party_shape || "" });
  }, [schedule]);

  const changed = form.name.trim() !== schedule.name || form.shape !== (schedule.party_shape || "");

  return (
    <FileSlot
      label={schedule.name}
      fileName={schedule.file_name}
      mime="application/pdf"
      present
      previewUrl={api.appendixFileUrl(schedule.id)}
      accept=".pdf,application/pdf"
      busy={busy}
      onUpload={onReplace}
      onDelete={onDelete}
    >
      <label>
        Name
        <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
      </label>
      <label>
        Used on
        <select value={form.shape} onChange={(e) => setForm((f) => ({ ...f, shape: e.target.value }))}>
          {USED_ON.map(([value, text]) => (
            <option key={value} value={value}>
              {text}
            </option>
          ))}
        </select>
      </label>
      <button
        className="btn secondary"
        type="button"
        disabled={busy || !changed || !form.name.trim()}
        onClick={() => onSave({ name: form.name.trim(), shape: form.shape })}
      >
        Save details
      </button>
      <FieldList fields={schedule.fields} empty="No signing fields." />
    </FileSlot>
  );
}

function FilePickerButton({ className, disabled, label, onFile }) {
  const inputRef = useRef(null);
  return (
    <>
      <button className={className} type="button" disabled={disabled} onClick={() => inputRef.current?.click()}>
        {label}
      </button>
      <input
        ref={inputRef}
        className="file-slot-input"
        type="file"
        accept=".pdf,application/pdf"
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

export function FieldList({ fields = [], roles = [], empty = "No fields detected." }) {
  const roleById = Object.fromEntries((roles || []).map((role) => [role.id, role]));
  if (!fields.length) return empty ? <p className="muted">{empty}</p> : null;
  return (
    <div className="field-list">
      {fields.map((field) => (
        <p className="meta" key={field.id || `${field.field_key}-${field.page}`}>
          {PARTY[field.role_key] || PARTY[roleById[field.role_id]?.role_key] || roleById[field.role_id]?.label || "Party"} ·{" "}
          {field.label} · page {(field.page || 0) + 1}
        </p>
      ))}
    </div>
  );
}

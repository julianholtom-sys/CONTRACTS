import { useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import ConfirmDialog from "./ConfirmDialog.jsx";
import FileSlot from "./FileSlot.jsx";

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
  const [draft, setDraft] = useState({ name: "", types: null });
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
      if (pending.pack) await api.deleteBrokerPack(entityId, pending.pack);
      else if (pending.type) await api.deleteBrokerContract(entityId, pending.type);
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

  const draftTypes = draft.types || data.types.map((type) => type.key);

  return (
    <section className="panel form-grid">
      <h2>{heading}</h2>
      <p className="muted">
        One PDF or Word file for each contract type. A Word contract is filled from the records for each contract.
        Schedules are ticked when a contract is created. Signing fields are found in each file.
      </p>
      {error ? <p className="error">{error}</p> : null}
      <div className="brand-slots template-slots">
        {data.types.map((type) => (
          <MasterSlot
            key={type.key}
            label={`${type.label} contract`}
            master={data.masters[type.key]}
            placeholder={data.placeholder}
            fileUrl={api.brokerContractFileUrl(entityId, type.key)}
            busy={Boolean(busy)}
            onUpload={(file, name) =>
              run(`upload-${type.key}`, () =>
                api.uploadBrokerContract(entityId, type.key, file, {
                  name: name || data.masters[type.key]?.name || "Master Services Agreement",
                })
              )
            }
            onRename={(name) => run(`name-${type.key}`, () => api.updateBrokerContract(entityId, type.key, { name }))}
            onDelete={() => setPending({ type: type.key, name: `${brokerName}’s ${type.label} contract` })}
          />
        ))}
      </div>

      <h3 style={{ margin: 0 }}>Due diligence packs</h3>
      <p className="muted">
        A Word pack for each 3-way type, filled on the contract and laid out with this broker’s covers. 4-way contracts use the
        app’s own pack.
      </p>
      <div className="brand-slots template-slots">
        {(data.pack_types || []).map((key) => {
          const type = data.types.find((item) => item.key === key);
          const pack = data.packs?.[key];
          return (
            <FileSlot
              key={key}
              label={`${type?.label || key} pack`}
              fileName={pack?.file_name}
              mime="application/pdf"
              present={Boolean(pack)}
              previewUrl={pack ? api.brokerPackFileUrl(entityId, key) : ""}
              accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              busy={Boolean(busy)}
              uploadLabel="Upload Word"
              emptyText="Not uploaded. These contracts use the app’s own pack until it is."
              onUpload={(file) => run(`pack-${key}`, () => api.uploadBrokerPack(entityId, key, file))}
              onDelete={pack ? () => setPending({ pack: key, name: `${brokerName}’s ${type?.label || key} pack` }) : null}
            />
          );
        })}
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
            <UsedOn
              types={data.types}
              value={draftTypes}
              onChange={(types) => setDraft((d) => ({ ...d, types }))}
            />
          </div>
          <div className="toolbar" style={{ margin: 0 }}>
            <button className="btn secondary" type="button" onClick={() => setAdding(false)}>
              Cancel
            </button>
            <FilePickerButton
              className="btn"
              disabled={Boolean(busy) || !draft.name.trim() || !draftTypes.length}
              label="Upload PDF"
              onFile={(file) =>
                run("add-schedule", async () => {
                  await api.addSchedule(entityId, { name: draft.name, types: draftTypes, file });
                  setDraft({ name: "", types: draftTypes });
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
              types={data.types}
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
            pending.pack
              ? `Delete ${pending.name}? New contracts of this type will use the app’s own pack. Packs already started keep theirs.`
              : pending.type
              ? `Delete ${pending.name}? ${
                  data.placeholder ? "New contracts of this type will use the placeholder until another is uploaded." : "New contracts of this type cannot be created until another is uploaded."
                } Existing contracts stay on file.`
              : `Delete ${pending.name}? Existing contracts stay on file.`
          }
          confirmLabel={pending.pack ? "Yes, delete pack" : pending.type ? "Yes, delete contract" : "Yes, delete schedule"}
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
      accept=".pdf,application/pdf,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      busy={busy}
      uploadLabel="Upload PDF or Word"
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
          {master.is_word ? <p className="meta">Word contract, filled for each contract</p> : null}
          <FieldList fields={master.fields} roles={master.roles} empty="No signing fields found. Replace the PDF to try again." />
        </>
      ) : null}
    </FileSlot>
  );
}

function UsedOn({ types, value, onChange }) {
  return (
    <div className="used-on">
      Used on
      {types.map((type) => (
        <label key={type.key} className="consent">
          <input
            type="checkbox"
            checked={value.includes(type.key)}
            onChange={(e) =>
              onChange(
                types
                  .map((item) => item.key)
                  .filter((key) => (key === type.key ? e.target.checked : value.includes(key)))
              )
            }
          />
          <span>{type.label}</span>
        </label>
      ))}
    </div>
  );
}

function ScheduleSlot({ schedule, types, busy, onSave, onReplace, onDelete }) {
  const [form, setForm] = useState({ name: schedule.name, types: schedule.contract_types });

  useEffect(() => {
    setForm({ name: schedule.name, types: schedule.contract_types });
  }, [schedule]);

  const changed = form.name.trim() !== schedule.name || form.types.join() !== schedule.contract_types.join();

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
      <UsedOn types={types} value={form.types} onChange={(next) => setForm((f) => ({ ...f, types: next }))} />
      <button
        className="btn secondary"
        type="button"
        disabled={busy || !changed || !form.name.trim() || !form.types.length}
        onClick={() => onSave({ name: form.name.trim(), types: form.types })}
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

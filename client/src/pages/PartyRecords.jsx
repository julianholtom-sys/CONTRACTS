import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api.js";
import { emptyParty } from "../PartyFields.jsx";
import SaveProgressBar from "../SaveProgressBar.jsx";
import SavedSignature from "../SavedSignature.jsx";

const COPY = {
  contractor: {
    title: "Contractors",
    one: "Contractor",
    path: "/contractors",
    intro: "Add the company number and the documents Companies House does not hold.",
  },
  supplier: {
    title: "Suppliers",
    one: "Supplier",
    path: "/suppliers",
    intro: "Add the company number and the HMRC PAYE letter.",
  },
};

export default function PartyRecords({ kind }) {
  const { id } = useParams();
  const copy = COPY[kind];
  if (!id) return <PartyList kind={kind} copy={copy} />;
  return <PartyEditor kind={kind} copy={copy} id={id} />;
}

function PartyList({ kind, copy }) {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .parties(kind)
      .then(setRows)
      .catch((err) => setError(err.message));
  }, [kind]);

  return (
    <div>
      <section className="hero-panel">
        <h1>{copy.title}</h1>
        <p>{copy.intro}</p>
      </section>
      <div className="toolbar">
        <Link className="btn" to={`${copy.path}/new`}>
          Add {copy.one.toLowerCase()}
        </Link>
      </div>
      {error ? <p className="error">{error}</p> : null}
      <div className="envelope-list">
        {rows.map((row) => (
          <div className="envelope-row" key={row.id}>
            <Link to={`${copy.path}/${row.id}`} className="envelope-row-main">
              <h3>
                {row.company_name}
                {row.is_sample ? " (sample)" : ""}
              </h3>
              <div className="meta">
                {row.company_number || "No company number"} · {row.signer_name}
                {row.uploadsComplete ? " · documents on file" : " · documents still needed"}
              </div>
            </Link>
          </div>
        ))}
      </div>
    </div>
  );
}

function PartyEditor({ kind, copy, id }) {
  const navigate = useNavigate();
  const isNew = id === "new";
  const [form, setForm] = useState(emptyParty());
  const [record, setRecord] = useState(null);
  const [details, setDetails] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const formRef = useRef(null);

  useEffect(() => {
    if (isNew) return;
    api
      .party(id)
      .then((data) => {
        setRecord(data);
        setForm(formFrom(data));
        setDetails(detailsFrom(data));
      })
      .catch((err) => setError(err.message));
  }, [id, isNew]);

  function setField(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  const formDirty = isNew
    ? JSON.stringify(formFrom(form)) !== JSON.stringify(formFrom(emptyParty()))
    : Boolean(record) && JSON.stringify(formFrom(form)) !== JSON.stringify(formFrom(record));
  const detailsDirty =
    Boolean(record && details) && JSON.stringify(details) !== JSON.stringify(detailsFrom(record));

  function onSaveProgress() {
    if (formDirty && !formRef.current?.reportValidity()) return;
    onSave();
  }

  async function onSave(event) {
    event?.preventDefault();
    setBusy("save");
    setError("");
    setNotice("");
    try {
      let saved = record;
      if (formDirty) {
        saved = isNew ? await api.saveParty(kind, form) : await api.updateParty(id, form);
        setRecord(saved);
        setForm(formFrom(saved));
      }
      if (!isNew && detailsDirty) {
        saved = await api.savePartyDetails(id, details);
        setRecord(saved);
        setDetails(detailsFrom(saved));
      }
      setNotice("Progress saved");
      if (isNew) navigate(`${copy.path}/${saved.id}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  async function onFetch() {
    setBusy("fetch");
    setError("");
    setNotice("Fetching Companies House and the UK Sanctions List…");
    try {
      const saved = await api.fetchPartyRegistry(record.id);
      setRecord(saved);
      setForm((current) => ({
        ...current,
        company_name: saved.company_name,
        company_number: saved.company_number,
      }));
      setNotice(
        saved.registry?.error
          ? `Fetched with a warning: ${saved.registry.error}`
          : "Updated."
      );
    } catch (err) {
      setNotice("");
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  async function onUpload(key, file) {
    setBusy(key);
    setError("");
    try {
      setRecord(await api.uploadPartyFile(record.id, key, file));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  return (
    <div>
      <section className="hero-panel">
        <h1>{isNew ? `Add a ${copy.one.toLowerCase()}` : form.company_name || copy.one}</h1>
        <p>{copy.intro}</p>
      </section>
      <div className="toolbar">
        <Link className="btn secondary" to={copy.path}>
          All {copy.title.toLowerCase()}
        </Link>
      </div>
      {error ? <p className="error">{error}</p> : null}
      {notice ? <p className="meta">{notice}</p> : null}
      <form ref={formRef} className="panel form-grid" onSubmit={onSave}>
        <h2>Company</h2>
        <label>
          Company number
          <input
            value={form.company_number || ""}
            onChange={(e) => setField("company_number", e.target.value)}
            placeholder="12345678"
            required
          />
        </label>
        <label>
          Company name
          <input
            value={form.company_name || ""}
            onChange={(e) => setField("company_name", e.target.value)}
            placeholder="Registered company name"
            required
          />
        </label>
        <label>
          Name in normal case (optional)
          <input
            value={form.normal_name || ""}
            onChange={(e) => setField("normal_name", e.target.value)}
            placeholder="e.g. MissionOpsAI Ltd"
          />
        </label>
        <label>
          Signatory
          <input
            value={form.signer_name || ""}
            onChange={(e) => setField("signer_name", e.target.value)}
            required
          />
        </label>
        <label>
          Role in the company
          <select
            value={form.signer_role || "director"}
            onChange={(e) => setField("signer_role", e.target.value)}
          >
            <option value="director">Director</option>
            <option value="authorised_signatory">Authorised signatory</option>
          </select>
        </label>
        <label>
          Email
          <input
            type="email"
            value={form.signer_email || ""}
            onChange={(e) => setField("signer_email", e.target.value)}
            required
          />
        </label>
      </form>

      {record ? (
        <>
          <section className="panel" style={{ marginTop: "1rem" }}>
            <h2>Companies House and sanctions</h2>
            <p className="muted">
              Fetches the incorporation, name changes, latest registered office, current PSC notices, directors and a sanctions search.
            </p>
            {record.registry?.fetched_at ? (
              <p className="meta">
                {record.registry.legal_name} · {record.registry.status} · incorporated{" "}
                {record.registry.incorporated_on} · {record.registry.registered_office}
                {record.registry.sanctions ? (
                  <>
                    {" · sanctions "}
                    {record.registry.sanctions.hitCount ? (
                      `${record.registry.sanctions.hitCount} possible match`
                    ) : (
                      <strong style={{ color: "var(--ok)" }}>Clear</strong>
                    )}
                  </>
                ) : null}
              </p>
            ) : (
              <p className="meta">Not fetched yet.</p>
            )}
            {record.registry?.fetched_at ? (
              <ul className="audit-list">
                {(record.registry.previous_names || []).map((item) => (
                  <li key={`prev-${item.name}`}>
                    <strong>Previously {item.name}</strong>
                    <span>{item.period}</span>
                  </li>
                ))}
                {(record.registry.officers || []).map((officer) => (
                  <li key={`officer-${officer.name}-${officer.role}`}>
                    <strong>{officer.name}</strong>
                    <span>
                      {officer.role} · {officer.status}
                    </span>
                  </li>
                ))}
                {(record.registry.pscs || []).map((person) => (
                  <li key={`psc-${person.name}`}>
                    <strong>{person.name}</strong>
                    <span>
                      Person with significant control
                      {person.ceasedOn ? ` · ceased ${person.ceasedOn}` : ""}
                    </span>
                  </li>
                ))}
                {(record.registry.sanctions?.hits || []).map((hit) => (
                  <li key={`hit-${hit.uniqueId}`}>
                    <strong>Possible sanctions match: {hit.name}</strong>
                    <span>
                      {hit.regime} · matched on {hit.matchedOn.join(", ")}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            <button className="btn" type="button" disabled={Boolean(busy)} onClick={onFetch}>
              {busy === "fetch" ? "Fetching…" : "Fetch from Companies House"}
            </button>
            {record.companiesHouseFiles?.length ? (
              <ul className="audit-list">
                {record.companiesHouseFiles.map((file) => (
                  <li key={file.id}>
                    <strong>{file.label}</strong>
                    <a href={api.partyFileUrl(record.id, file.id)} target="_blank" rel="noreferrer">
                      Open
                    </a>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
          <section className="panel form-grid" style={{ marginTop: "1rem" }}>
            <h2>Documents to add</h2>
            {record.uploads.map((item) => (
              <UploadRow key={item.key} item={item} disabled={Boolean(busy)} onUpload={onUpload} />
            ))}
          </section>
          {record.fourWayUploads?.length ? (
            <section className="panel form-grid" style={{ marginTop: "1rem" }}>
              <h2>On a 4-way</h2>
              <p className="muted">From this contractor’s Employers’ Liability policy.</p>
              {record.fourWayUploads.map((item) => (
                <UploadRow key={item.key} item={item} disabled={Boolean(busy)} onUpload={onUpload} />
              ))}
            </section>
          ) : null}
          {details ? <PayeInsurance record={record} value={details} onChange={setDetails} /> : null}
          <section className="panel form-grid" style={{ marginTop: "1rem" }}>
            <h2>Signing</h2>
            <p className="muted">
              Applied to each contract for {record.signer_name} when it is sent, dated that day. The director ID is
              bound into the signed contract, not the pack.
            </p>
            <SavedSignature
              partyId={record.id}
              signerName={record.signer_name}
              signature={record.signature}
              onSaved={setRecord}
            />
            {record.signingUploads.map((item) => (
              <UploadRow key={item.key} item={item} disabled={Boolean(busy)} onUpload={onUpload} />
            ))}
          </section>
        </>
      ) : null}
      <SaveProgressBar dirty={formDirty || detailsDirty} saving={busy === "save"} onSave={onSaveProgress} />
    </div>
  );
}

function UploadRow({ item, disabled, onUpload }) {
  return (
    <div>
      <strong>
        {item.label}{" "}
        <span className={`badge ${item.file ? "completed" : "draft"}`}>{item.file ? "on file" : "needed"}</span>
      </strong>
      {item.file ? <p className="meta">{item.file.original_name}</p> : null}
      <label className="muted">
        {item.file ? "Replace" : "Upload"}
        <input
          type="file"
          accept=".pdf,.png,.jpg,.jpeg"
          aria-label={`${item.file ? "Replace" : "Upload"} ${item.label}`}
          disabled={disabled}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) onUpload(item.key, file);
          }}
        />
      </label>
    </div>
  );
}

function formFrom(data) {
  return {
    company_name: data.company_name || "",
    normal_name: data.normal_name || "",
    company_number: data.company_number || "",
    signer_name: data.signer_name || "",
    signer_role: data.signer_role || "director",
    signer_email: data.signer_email || "",
  };
}

function detailsFrom(record) {
  return {
    payeReference: record.paye_reference || "",
    insurance: Object.fromEntries(
      (record.insurance || []).map((policy) => [
        policy.key,
        {
          insurer: policy.insurer,
          policyNumber: policy.policyNumber,
          cover: policy.cover == null ? "" : String(policy.cover),
          expiresOn: policy.expiresOn,
        },
      ])
    ),
  };
}

function PayeInsurance({ record, value: form, onChange }) {
  const setPolicy = (key, field) => (e) =>
    onChange({
      ...form,
      insurance: { ...form.insurance, [key]: { ...form.insurance[key], [field]: e.target.value } },
    });

  return (
    <section className="panel form-grid" style={{ marginTop: "1rem" }}>
      <h2>{record.insurance?.length ? "PAYE and insurance" : "PAYE reference"}</h2>
      <label>
        PAYE reference
        <input
          value={form.payeReference}
          onChange={(e) => onChange({ ...form, payeReference: e.target.value })}
          placeholder="123/AB45678"
        />
      </label>
      <p className="muted">Needed when this company employs the workers.</p>
      {(record.insurance || []).map((policy) => {
        const value = form.insurance[policy.key] || {};
        return (
          <div key={policy.key}>
            <strong>{policy.label}</strong>
            <div className="signer-row">
              <label>
                Insurer
                <input value={value.insurer || ""} onChange={setPolicy(policy.key, "insurer")} />
              </label>
              <label>
                Policy number
                <input value={value.policyNumber || ""} onChange={setPolicy(policy.key, "policyNumber")} />
              </label>
            </div>
            <div className="signer-row">
              <label>
                Cover (£)
                <input
                  inputMode="numeric"
                  value={value.cover || ""}
                  onChange={setPolicy(policy.key, "cover")}
                  placeholder={policy.key === "el" ? "5000000" : ""}
                />
              </label>
              <label>
                Expiry
                <input type="date" value={value.expiresOn || ""} onChange={setPolicy(policy.key, "expiresOn")} />
              </label>
            </div>
          </div>
        );
      })}
    </section>
  );
}

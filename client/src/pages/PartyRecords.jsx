import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api.js";
import { emptyParty } from "../PartyFields.jsx";

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
    intro: "Add the company number, the HMRC PAYE letter and the Employers’ Liability documents.",
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
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");

  useEffect(() => {
    if (isNew) return;
    api
      .party(id)
      .then((data) => {
        setRecord(data);
        setForm({
          company_name: data.company_name,
          company_number: data.company_number,
          signer_name: data.signer_name,
          signer_role: data.signer_role,
          signer_email: data.signer_email,
        });
      })
      .catch((err) => setError(err.message));
  }, [id, isNew]);

  function setField(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function onSave(event) {
    event.preventDefault();
    setBusy("save");
    setError("");
    setNotice("");
    try {
      const saved = isNew
        ? await api.saveParty(kind, form)
        : await api.updateParty(id, form);
      setRecord(saved);
      setNotice("Saved");
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
      <form className="panel form-grid" onSubmit={onSave}>
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
        <button className="btn" type="submit" disabled={Boolean(busy)}>
          {busy === "save" ? "Saving…" : "Save"}
        </button>
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
                {record.registry.sanctions
                  ? ` · sanctions ${record.registry.sanctions.hitCount ? `${record.registry.sanctions.hitCount} possible match` : "CLEAN"}`
                  : ""}
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
              <div key={item.key}>
                <strong>
                  {item.label}{" "}
                  <span className={`badge ${item.file ? "completed" : "draft"}`}>
                    {item.file ? "on file" : "needed"}
                  </span>
                </strong>
                {item.file ? <p className="meta">{item.file.original_name}</p> : null}
                <label className="muted">
                  {item.file ? "Replace" : "Upload"}
                  <input
                    type="file"
                    accept=".pdf,.png,.jpg,.jpeg"
                    aria-label={`${item.file ? "Replace" : "Upload"} ${item.label}`}
                    disabled={Boolean(busy)}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = "";
                      if (file) onUpload(item.key, file);
                    }}
                  />
                </label>
              </div>
            ))}
          </section>
        </>
      ) : null}
    </div>
  );
}

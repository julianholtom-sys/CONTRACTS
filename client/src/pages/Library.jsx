import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";
import { emptyParty, PartyFields } from "../PartyFields.jsx";

export default function Library() {
  const [bootstrap, setBootstrap] = useState(null);
  const [records, setRecords] = useState({ broker: [], contractor: [] });
  const [saved, setSaved] = useState([]);
  const [name, setName] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [entityId, setEntityId] = useState("");
  const [broker, setBroker] = useState(emptyParty());
  const [contractor, setContractor] = useState(emptyParty());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    const [boot, library, brokers, contractors] = await Promise.all([
      api.bootstrap(),
      api.library(),
      api.directory("broker"),
      api.directory("contractor"),
    ]);
    setBootstrap(boot);
    setSaved(library);
    setRecords({ broker: brokers, contractor: contractors });
    setTemplateId((current) => current || boot.masterTemplate?.id || boot.templates?.[0]?.id || "");
    setEntityId((current) => current || boot.entities?.[0]?.id || "");
  }

  useEffect(() => {
    load().catch((err) => setError(err.message));
  }, []);

  function chooseBroker(next) {
    setBroker((current) => {
      const resolved = typeof next === "function" ? next(current) : next;
      if (resolved.entity_id) setEntityId(resolved.entity_id);
      return resolved;
    });
  }

  function chooseContractor(next) {
    setContractor((current) => (typeof next === "function" ? next(current) : next));
  }

  async function onSubmit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.saveLibrary({
        name,
        templateId,
        entityId,
        broker,
        contractor,
      });
      setName("");
      setBroker(emptyParty());
      setContractor(emptyParty());
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!bootstrap) return <p className="muted">Loading…</p>;

  return (
    <div>
      <section className="hero-panel">
        <h1>Library</h1>
        <p>
          Pair a broker with a contractor. That pairing chooses the contract and the
          cover. Pull it up later, then name the client and, when needed, the supplier.
        </p>
      </section>

      <section className="panel">
        <h2>Saved templates</h2>
        {saved.length === 0 ? (
          <p className="muted">Nothing saved yet.</p>
        ) : (
          <ul className="audit-list">
            {saved.map((item) => (
              <li key={item.id}>
                <strong>
                  {item.name}{" "}
                  {item.is_sample ? <span className="badge draft">Sample</span> : null}
                </strong>
                <span>
                  {item.broker.company_name} / {item.contractor.company_name} · {item.template_name}
                  {" · "}
                  Cover {item.cover.front || "not set"}
                </span>
                {item.sample_note ? <span>{item.sample_note}</span> : null}
              </li>
            ))}
          </ul>
        )}
        <p>
          <Link className="btn" to="/new">
            Start a contract from the library
          </Link>
        </p>
      </section>

      <form className="panel form-grid" onSubmit={onSubmit}>
        <h2>Save a broker and contractor</h2>
        <label>
          Template name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Bailey, Northwind, Casey & Nina North (sample)"
            required
          />
        </label>
        <label>
          Contract
          <select value={templateId} onChange={(e) => setTemplateId(e.target.value)} required>
            {(bootstrap.templates || []).map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Cover company
          <select
            value={entityId}
            onChange={(e) => setEntityId(e.target.value)}
            required
            disabled={Boolean(broker.entity_id)}
          >
            {bootstrap.entities.map((entity) => (
              <option key={entity.id} value={entity.id}>
                {entity.display_name}
              </option>
            ))}
          </select>
        </label>
        <p className="muted">
          The cover and logo come from that company’s brand pack. Each party gets a
          signature and a date on the contract: the client signs by link, the others with
          the signature saved on their record. The broker signs and dates the due
          diligence pack.
        </p>
        <section className="party-card">
          <h3>Broker</h3>
          <PartyFields value={broker} onChange={chooseBroker} records={records.broker} />
        </section>
        <section className="party-card">
          <h3>Contractor</h3>
          <PartyFields
            value={contractor}
            onChange={chooseContractor}
            records={records.contractor}
          />
        </section>
        {error ? <p className="error">{error}</p> : null}
        <button className="btn" type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save to the library"}
        </button>
      </form>
    </div>
  );
}

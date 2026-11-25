import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";
import ConfirmDialog from "../ConfirmDialog.jsx";

export default function Companies() {
  const [companies, setCompanies] = useState([]);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");
  const [pending, setPending] = useState(null);

  function load() {
    return api
      .listEntities()
      .then(setCompanies)
      .catch((err) => setError(err.message));
  }

  useEffect(() => {
    load();
  }, []);

  async function confirmDelete() {
    if (!pending) return;
    setBusyId(pending.id);
    setError("");
    try {
      await api.deleteEntity(pending.id);
      setPending(null);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId("");
    }
  }

  return (
    <div>
      <section className="hero-panel">
        <h1>Brokers</h1>
        <p>
          Each broker has company details, a front cover, a back cover, and a brand
          SVG. Those files are applied to the contracts that broker sends.
        </p>
      </section>
      <div className="toolbar">
        <Link className="btn" to="/brokers/new">
          Add broker
        </Link>
      </div>
      {error ? <p className="error">{error}</p> : null}
      <div className="envelope-list">
        {companies.map((company, i) => (
          <div
            key={company.id}
            className="envelope-row"
            style={{ animationDelay: `${Math.min(i, 8) * 0.04}s` }}
          >
            <Link to={`/brokers/${company.id}`} className="envelope-row-main">
              <h3>{company.display_name}</h3>
              <div className="meta">
                {company.legal_name} · {company.company_number}
              </div>
            </Link>
            <div className="envelope-row-actions">
              <button
                type="button"
                className="btn danger"
                disabled={Boolean(busyId)}
                onClick={() => setPending(company)}
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>
      {pending ? (
        <ConfirmDialog
          title="Are you sure?"
          message={`Delete ${pending.display_name}? It will leave the broker list. Existing contracts stay on file.`}
          confirmLabel="Yes, delete broker"
          busy={busyId === pending.id}
          onCancel={() => (busyId ? null : setPending(null))}
          onConfirm={confirmDelete}
        />
      ) : null}
    </div>
  );
}

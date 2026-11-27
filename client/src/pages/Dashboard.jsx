import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";

export default function Dashboard() {
  const [envelopes, setEnvelopes] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const data = await api.listEnvelopes();
        if (alive) setEnvelopes(data);
      } catch (err) {
        if (alive) setError(err.message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div>
      <section className="hero-panel">
        <h1>Contracts in progress</h1>
        <p>Drafts and contracts that have already been started.</p>
      </section>

      <div className="toolbar">
        <Link className="btn" to="/">
          Start another
        </Link>
      </div>

      {error ? <p className="error">{error}</p> : null}
      {loading ? <p className="muted">Loading…</p> : null}

      {!loading && envelopes.length === 0 ? (
        <div className="empty">No contracts yet.</div>
      ) : (
        <div className="envelope-list">
          {envelopes.map((env, i) => (
            <Link
              key={env.id}
              to={`/envelopes/${env.id}`}
              className="envelope-row"
              style={{ animationDelay: `${Math.min(i, 8) * 0.04}s` }}
            >
              <div>
                <h3>
                  {env.title || "Untitled"}{" "}
                  {env.is_sample ? <span className="badge draft">Sample</span> : null}
                </h3>
                <div className="meta">
                  {env.entity?.display_name || "Entity"} · {env.contract_type_label || `${env.party_count} parties`} ·{" "}
                  {new Date(env.created_at).toLocaleString("en-GB")}
                </div>
              </div>
              <span className={`badge ${env.status}`}>{env.status}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

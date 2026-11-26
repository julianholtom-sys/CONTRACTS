import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api.js";
import SignaturePad from "../SignaturePad.jsx";

export default function DiligenceRoom() {
  const { token } = useParams();
  const [session, setSession] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [previousName, setPreviousName] = useState("");
  const [newName, setNewName] = useState("");
  const [signature, setSignature] = useState(null);
  const [consent, setConsent] = useState(false);

  async function reload() {
    setSession(await api.diligenceSession(token));
  }

  useEffect(() => {
    reload().catch((err) => setError(err.message));
  }, [token]);

  async function run(action, fn) {
    setBusy(action);
    setError("");
    try {
      setSession(await fn());
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  if (error && !session) return <p className="error">{error}</p>;
  if (!session) return <p className="muted">Opening your document page…</p>;

  const section = session.section;
  const locked = !session.editable;

  return (
    <div>
      <section className="hero-panel">
        <h1>
          {session.party.role_label}: {session.party.signer_name}
        </h1>
        <p>
          {session.envelope.title}
          {session.party.company_name ? ` · ${session.party.company_name}` : ""}
        </p>
      </section>
      {error ? <p className="error">{error}</p> : null}

      {session.mode === "sign" ? (
        <div className="split">
          {session.compiled ? (
            <iframe
              title="Due diligence pack"
              className="pdf-frame"
              src={api.diligencePackUrl(token)}
            />
          ) : (
            <section className="panel">
              <h2>Pack not ready</h2>
              <p>The pack has not been compiled yet.</p>
            </section>
          )}
          <section className="panel form-grid">
            <h2>Sign the due diligence pack</h2>
            {session.signed ? (
              <p>
                {`You signed this pack${session.signedAt ? ` on ${new Date(session.signedAt).toLocaleString("en-GB")}` : ""}.`}
              </p>
            ) : (
              <>
                <p>{session.consent}</p>
                <SignaturePad onChange={setSignature} defaultName={session.party.signer_name} />
                <label className="consent">
                  <input
                    type="checkbox"
                    checked={consent}
                    onChange={(e) => setConsent(e.target.checked)}
                  />
                  <span>I have checked this pack and sign the director’s certificate</span>
                </label>
                {session.blockers?.length ? (
                  <ul className="audit-list">
                    {session.blockers.map((item) => (
                      <li key={item}>
                        <strong>Before signing</strong>
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <button
                  type="button"
                  className="btn"
                  disabled={busy || !session.compiled || !consent || !signature || locked || Boolean(session.blockers?.length)}
                  onClick={() =>
                    run("sign", () =>
                      api.signDiligence(token, {
                        signatureDataUrl: signature.dataUrl,
                        method: signature.method,
                        typedName: session.party.signer_name,
                        consent,
                      })
                    )
                  }
                >
                  {busy === "sign" ? "Signing…" : "Sign the pack"}
                </button>
              </>
            )}
          </section>
        </div>
      ) : (
        <section className="panel form-grid">
          <h2>Documents requested from you</h2>
          {section.heldOnRecord ? (
            <p>These documents are held on the company record.</p>
          ) : null}
          {section.heldOnRecord ? null : (
          <>
          {section.roleKey === "company" ? (
            <p className="muted">Add each change of name with its certificate. If none, submit as is.</p>
          ) : (
            <p className="muted">
              Upload each document below. Add a certificate for every name change.
            </p>
          )}
          {session.signed ? (
            <p className="meta">
              The broker has signed this pack. Replacing a document clears that
              signature, and the broker will be asked to sign again.
            </p>
          ) : null}
          {section.submittedAt ? (
            <p className="meta">{`Submitted ${new Date(section.submittedAt).toLocaleString("en-GB")}.`}</p>
          ) : null}
          {section.roleKey === "supplier" ? (
            <label className="consent">
              <input
                type="checkbox"
                checked={Boolean(section.officeChanged)}
                disabled={locked}
                onChange={(e) =>
                  run("office", () => api.setPartyOfficeChanged(token, e.target.checked))
                }
              />
              <span>Registered office has changed</span>
            </label>
          ) : null}
          {section.items
            .filter((item) => item.required || item.key === "registered_office")
            .map((item) => (
              <div key={item.key}>
                <strong>
                  {item.label}{" "}
                  {item.required ? (
                    <span className={`badge ${item.satisfied ? "completed" : "sent"}`}>
                      {item.satisfied ? "received" : "needed"}
                    </span>
                  ) : (
                    <span className="muted">not requested</span>
                  )}
                </strong>
                {item.file ? <p className="meta">{item.file.original_name}</p> : null}
                {item.required && !locked ? (
                  <label className="muted">
                    Upload
                    <input
                      type="file"
                      accept=".pdf,.png,.jpg,.jpeg"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        e.target.value = "";
                        if (!file) return;
                        run(item.key, () =>
                          api.uploadPartyDiligence(token, { requirementKey: item.key, file })
                        );
                      }}
                    />
                  </label>
                ) : null}
              </div>
            ))}
          {section.nameChanges.map((change) => (
            <div key={change.id}>
              <strong>
                {change.label}{" "}
                <span className={`badge ${change.satisfied ? "completed" : "sent"}`}>
                  {change.satisfied ? "received" : "needed"}
                </span>
              </strong>
              {change.file ? <p className="meta">{change.file.original_name}</p> : null}
              {!locked ? (
                <div className="toolbar">
                  <label className="muted">
                    Upload certificate and resolution
                    <input
                      type="file"
                      accept=".pdf,.png,.jpg,.jpeg"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        e.target.value = "";
                        if (!file) return;
                        run(change.id, () =>
                          api.uploadPartyDiligence(token, { nameChangeId: change.id, file })
                        );
                      }}
                    />
                  </label>
                  <button
                    type="button"
                    className="btn secondary"
                    onClick={() => run(`drop-${change.id}`, () => api.removePartyNameChange(token, change.id))}
                  >
                    Remove change
                  </button>
                </div>
              ) : null}
            </div>
          ))}
          {!locked ? (
            <div className="signer-row">
              <label>
                Previous name
                <input
                  value={previousName}
                  onChange={(e) => setPreviousName(e.target.value)}
                  placeholder="Name before the change"
                />
              </label>
              <label>
                New name
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Name after the change"
                />
              </label>
              <button
                type="button"
                className="btn secondary"
                onClick={() =>
                  run("add", async () => {
                    const next = await api.addPartyNameChange(token, { previousName, newName });
                    setPreviousName("");
                    setNewName("");
                    return next;
                  })
                }
              >
                Add name change
              </button>
            </div>
          ) : null}
          {!locked ? (
            <button
              type="button"
              className="btn"
              disabled={Boolean(busy)}
              onClick={() => run("submit", () => api.submitDiligence(token))}
            >
              {busy === "submit" ? "Submitting…" : "Submit documents"}
            </button>
          ) : (
            <p className="muted">These documents are locked because the contract has been issued.</p>
          )}
          </>
          )}
        </section>
      )}
    </div>
  );
}

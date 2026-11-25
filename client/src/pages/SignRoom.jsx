import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api.js";
import SignaturePad from "../SignaturePad.jsx";

export default function SignRoom() {
  const { token } = useParams();
  const [session, setSession] = useState(null);
  const [error, setError] = useState("");
  const [signature, setSignature] = useState(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [jumpPage, setJumpPage] = useState(null);
  const [fieldValues, setFieldValues] = useState({});

  async function reload() {
    const next = await api.signSession(token);
    setSession(next);
    const map = {};
    for (const value of next.values || []) map[value.field_id] = value.value;
    setFieldValues(map);
  }

  useEffect(() => {
    reload().catch((err) => setError(err.message));
  }, [token]);

  async function onUpload(requirementId, file) {
    setError("");
    try {
      const result = await api.uploadEvidence(token, requirementId, file);
      setSession((prev) => ({
        ...prev,
        checklist: result.checklist,
        gate: result.gate,
      }));
    } catch (err) {
      setError(err.message);
    }
  }

  async function saveFieldValue(field, value) {
    setFieldValues((prev) => ({ ...prev, [field.id]: value }));
    setError("");
    try {
      await api.saveField(token, field.id, value);
    } catch (err) {
      setError(err.message);
    }
  }

  async function saveDateFields() {
    const dateFields = (session.fields || []).filter((f) => f.field_type === "date");
    const today = new Date().toISOString().slice(0, 10);
    for (const field of dateFields) {
      if (fieldValues[field.id]) continue;
      await api.saveField(token, field.id, today);
      setFieldValues((prev) => ({ ...prev, [field.id]: today }));
    }
  }

  async function submitSign() {
    setBusy(true);
    setError("");
    try {
      await saveDateFields();
      await api.sign(token, {
        signatureDataUrl: signature.dataUrl,
        method: signature.method,
        font: signature.font,
        consent,
        typedName: signature.text || session.party.signer_name,
      });
      setDone(true);
      await reload();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (error && !session) return <p className="error">{error}</p>;
  if (!session) return <p className="muted">Validating signing link…</p>;

  const gateOk = session.gate?.ok;
  const partyFields = session.fields || [];
  const missingFields = partyFields.filter((field) => {
    if (!field.required) return false;
    if (field.field_type === "signature" || field.field_type === "initials") return false;
    const value = fieldValues[field.id];
    return value == null || value === "" || value === false;
  });
  const pdfSrc = jumpPage
    ? `${session.document_url}#page=${jumpPage}`
    : session.document_url;

  return (
    <div>
      <section className="hero-panel">
        <h1>
          Sign as {session.party.role_label}: {session.party.signer_name}
          {session.party.signer_role === "authorised_signatory"
            ? " (Authorised signatory)"
            : session.party.signer_role === "director"
              ? " (Director)"
              : ""}
        </h1>
        <p>
          {session.envelope.title}. Document hash must match the baked snapshot at
          signature time.
        </p>
      </section>

      {!session.is_turn ? (
        <p className="error">It is not your turn yet (sequential signing).</p>
      ) : null}

      <div className="split">
        <iframe
          key={pdfSrc}
          title="Baked document"
          className="pdf-frame"
          src={pdfSrc}
        />

        <div className="panel form-grid">
          {partyFields.length ? (
            <div>
              <h2>Your fields</h2>
              <p className="muted">
                Jump to each place in the contract that needs your details or
                signature. Appendix acceptance fields are included when those
                terms need signing too.
              </p>
              <div className="form-grid">
                {partyFields.map((field) => (
                  <div className="party-card" key={field.id}>
                    <div className="toolbar" style={{ margin: 0 }}>
                      <strong>{field.label}</strong>
                      <button
                        className="btn secondary"
                        type="button"
                        onClick={() => setJumpPage(field.jump_page || 1)}
                      >
                        Jump to
                      </button>
                    </div>
                    <p className="meta">
                      {field.source_label} · page {field.jump_page || 1} · {field.field_type}
                    </p>
                    {field.field_type === "text" ? (
                      <input
                        value={fieldValues[field.id] || ""}
                        placeholder={field.label}
                        onChange={(e) =>
                          setFieldValues((prev) => ({
                            ...prev,
                            [field.id]: e.target.value,
                          }))
                        }
                        onBlur={(e) => saveFieldValue(field, e.target.value)}
                      />
                    ) : null}
                    {field.field_type === "date" ? (
                      <input
                        type="date"
                        value={fieldValues[field.id] || ""}
                        onChange={(e) => saveFieldValue(field, e.target.value)}
                      />
                    ) : null}
                    {field.field_type === "checkbox" ? (
                      <label className="consent">
                        <input
                          type="checkbox"
                          checked={Boolean(fieldValues[field.id])}
                          onChange={(e) =>
                            saveFieldValue(field, e.target.checked ? "yes" : "")
                          }
                        />
                        <span>I accept these terms</span>
                      </label>
                    ) : null}
                    {field.field_type === "signature" || field.field_type === "initials" ? (
                      <p className="muted">Use the signature pad below for this field.</p>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {session.checklist?.length ? (
            <div>
              <h2>Final evidence appendix</h2>
              <p className="muted">Upload these before signing.</p>
              <div className="form-grid">
                {session.checklist.map((item) => (
                  <div className="party-card" key={item.id}>
                    <strong>
                      {item.label}{" "}
                      <span className={`badge ${item.satisfied ? "completed" : "sent"}`}>
                        {item.satisfied ? "satisfied" : "required"}
                      </span>
                    </strong>
                    {item.description && item.description !== item.label ? (
                      <p className="muted">{item.description}</p>
                    ) : null}
                    {(item.files || []).length ? (
                      <ul className="meta" style={{ margin: "0.35rem 0" }}>
                        {item.files.map((file) => (
                          <li key={file.id}>{file.original_name}</li>
                        ))}
                      </ul>
                    ) : null}
                    <label className="muted">
                      {item.allow_multiple && (item.files || []).length
                        ? "Add another file"
                        : "Upload file"}
                      <input
                        type="file"
                        accept=".pdf,.png,.jpg,.jpeg"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) onUpload(item.id, file);
                          e.target.value = "";
                        }}
                      />
                    </label>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <label className="consent">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
            />
            <span>{session.consent_text}</span>
          </label>

          <div>
            <div className="muted" style={{ marginBottom: "0.4rem" }}>
              Your signature
            </div>
            <SignaturePad onChange={setSignature} defaultName={session.party.signer_name} />
          </div>

          {error ? <p className="error">{error}</p> : null}
          {done ? (
            <p className="meta">Signature captured. Status: {session.envelope.status}</p>
          ) : null}

          <button
            className="btn"
            type="button"
            disabled={
              busy ||
              !consent ||
              !signature ||
              !session.is_turn ||
              !gateOk ||
              missingFields.length > 0
            }
            onClick={submitSign}
          >
            {busy
              ? "Signing…"
              : !gateOk
                ? "Evidence gate locked"
                : missingFields.length
                  ? "Complete required fields"
                  : "Finish & sign"}
          </button>
        </div>
      </div>
    </div>
  );
}

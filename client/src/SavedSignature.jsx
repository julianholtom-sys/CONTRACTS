import { useState } from "react";
import { api } from "./api.js";
import SignaturePad from "./SignaturePad.jsx";

/** The signature applied for this signatory when a contract is sent: typed in a handwriting font, or an uploaded image. */
export default function SavedSignature({ partyId, signerName, signature, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const showPad = editing || !signature;

  async function save() {
    setBusy(true);
    setError("");
    try {
      const saved = await api.savePartySignature(partyId, draft);
      setEditing(false);
      setDraft(null);
      onSaved?.(saved);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sig-stack">
      {showPad ? (
        <>
          <SignaturePad key={signerName} modes={["typed", "uploaded"]} defaultName={signerName} onChange={setDraft} />
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            <button type="button" className="btn" disabled={!draft || busy} onClick={save}>
              {busy ? "Saving…" : "Save signature"}
            </button>
            {signature ? (
              <button
                type="button"
                className="btn secondary"
                disabled={busy}
                onClick={() => {
                  setEditing(false);
                  setDraft(null);
                }}
              >
                Cancel
              </button>
            ) : null}
          </div>
        </>
      ) : (
        <>
          <div className="sig-preview">
            <span className="muted">{signerName}</span>
            <img src={signature.url} alt={`${signerName}’s signature`} />
          </div>
          <div>
            <button type="button" className="btn secondary" onClick={() => setEditing(true)}>
              Change signature
            </button>
          </div>
        </>
      )}
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}

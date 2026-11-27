import { useEffect, useState } from "react";
import { api } from "../api.js";
import BrokerContracts, { FieldList } from "../BrokerContracts.jsx";
import ConfirmDialog from "../ConfirmDialog.jsx";
import FileSlot from "../FileSlot.jsx";

export default function Templates() {
  const [brokers, setBrokers] = useState([]);
  const [master, setMaster] = useState(null);
  const [masterName, setMasterName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [pending, setPending] = useState(false);

  async function reloadPlaceholder() {
    const m = await api.getMasterTemplate();
    setMaster(m);
    setMasterName(m?.name || "");
  }

  useEffect(() => {
    Promise.all([api.bootstrap(), reloadPlaceholder()])
      .then(([boot]) => setBrokers(boot.entities || []))
      .catch((err) => setError(err.message));
  }, []);

  async function run(label, fn) {
    setBusy(label);
    setError("");
    try {
      await fn();
      await reloadPlaceholder();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  return (
    <div>
      <section className="hero-panel">
        <h1>Templates</h1>
        <p>Each broker has a 3-way lower, a 3-way higher and a 4-way contract, and its own schedules.</p>
      </section>
      {error ? <p className="error">{error}</p> : null}

      {brokers.map((broker) => (
        <div key={broker.id} id={`broker-${broker.id}`} style={{ marginBottom: "1.25rem" }}>
          <BrokerContracts entityId={broker.id} brokerName={broker.display_name} heading={broker.display_name} />
        </div>
      ))}

      <section className="panel form-grid" style={{ marginBottom: "1.25rem" }}>
        <h2>Placeholder contract</h2>
        <p className="muted">Used when a broker has no contract of its own for that shape.</p>
        {master ? (
          <div className="signer-row">
            <label>
              Name
              <input
                value={masterName}
                onChange={(e) => setMasterName(e.target.value)}
                placeholder="Master Services Agreement"
              />
            </label>
            <button
              className="btn secondary"
              type="button"
              disabled={Boolean(busy) || !masterName.trim() || masterName.trim() === master.name}
              onClick={() => run("save-master", () => api.updateMasterTemplate({ name: masterName.trim() }))}
            >
              {busy === "save-master" ? "Saving…" : "Save name"}
            </button>
          </div>
        ) : null}
        <FileSlot
          label="Placeholder PDF"
          fileName={master?.file_name || master?.name}
          mime="application/pdf"
          present={Boolean(master?.id)}
          previewUrl={master ? api.masterFileUrl() : ""}
          accept=".pdf,application/pdf"
          busy={Boolean(busy)}
          uploadLabel="Upload PDF"
          emptyText="No placeholder. A broker needs its own contract for each shape it sends."
          onUpload={(file) =>
            run("upload-master", () =>
              api.uploadMasterTemplate(file, { name: masterName || file.name.replace(/\.pdf$/i, "") })
            )
          }
          onDelete={master ? () => setPending(true) : null}
        >
          {master ? <FieldList fields={master.fields} roles={master.roles} /> : null}
        </FileSlot>
      </section>

      {pending ? (
        <ConfirmDialog
          title="Are you sure?"
          message={`Delete the placeholder contract (${master?.name})? A broker without its own contract for a shape cannot send that shape until one is uploaded. Existing contracts stay on file.`}
          confirmLabel="Yes, delete placeholder"
          busy={Boolean(busy)}
          onCancel={() => (busy ? null : setPending(false))}
          onConfirm={() =>
            run("delete-master", async () => {
              await api.deleteMasterTemplate();
              setPending(false);
            })
          }
        />
      ) : null}
    </div>
  );
}

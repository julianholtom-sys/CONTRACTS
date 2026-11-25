import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../api.js";
import { emptyParty, PartyFields } from "../PartyFields.jsx";
import ConfirmDialog from "../ConfirmDialog.jsx";
import FileSlot from "../FileSlot.jsx";
import ComplianceCompany from "./ComplianceCompany.jsx";

const emptyForm = {
  slug: "",
  display_name: "",
  legal_name: "",
  company_number: "",
  registered_office: "",
  brand: { primary: "#0074ff", secondary: "#101828", font: "Manrope" },
};

const KIND_LABELS = {
  front_cover: "front cover",
  back_cover: "back cover",
  logo: "brand SVG",
};

function formPayload(form) {
  return { ...form };
}

function formFromEntity(data) {
  return {
    slug: data.slug,
    display_name: data.display_name,
    legal_name: data.legal_name,
    company_number: data.company_number,
    registered_office: data.registered_office,
    brand: data.brand || emptyForm.brand,
  };
}

export default function CompanySetup() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const nextPath = searchParams.get("next") || "";
  const isNew = id === "new";
  const navigate = useNavigate();
  const [form, setForm] = useState(emptyForm);
  const [signatory, setSignatory] = useState(emptyParty());
  const [signatoryId, setSignatoryId] = useState("");
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [saveState, setSaveState] = useState("");
  const [pendingCompanyDelete, setPendingCompanyDelete] = useState(false);
  const [pendingAsset, setPendingAsset] = useState(null);
  const [tab, setTab] = useState(() => {
    if (typeof window === "undefined") return "company";
    if (window.location.hash === "#compliance") return "compliance";
    return "company";
  });
  const autosaveReady = useRef(false);
  const lastSaved = useRef("");

  async function load() {
    if (isNew) return;
    autosaveReady.current = false;
    const [data, people] = await Promise.all([api.getEntity(id), api.directory("broker")]);
    const next = formFromEntity(data);
    const mine = people.find((row) => row.entity_id === id);
    setDetail(data);
    setForm(next);
    setSignatoryId(mine?.id || "");
    setSignatory(
      mine ? { ...mine, id: "" } : { ...emptyParty(), company_name: data.display_name }
    );
    lastSaved.current = JSON.stringify(formPayload(next));
    setSaveState("saved");
    autosaveReady.current = true;
  }

  useEffect(() => {
    load().catch((err) => setError(err.message));
  }, [id]);

  useEffect(() => {
    if (isNew || !autosaveReady.current) return;
    const payload = formPayload(form);
    const snap = JSON.stringify(payload);
    if (snap === lastSaved.current) return undefined;
    setSaveState("saving");
    const timer = setTimeout(async () => {
      try {
        await api.updateEntity(id, payload);
        lastSaved.current = JSON.stringify(formPayload(form));
        setSaveState("saved");
      } catch (err) {
        setSaveState("error");
        setError(err.message);
      }
    }, 700);
    return () => clearTimeout(timer);
  }, [form, id, isNew]);

  function setField(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function selectTab(next) {
    setTab(next);
    if (typeof window !== "undefined") {
      const hash = next === "company" ? "" : `#${next}`;
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${hash}`);
    }
  }

  async function saveNew(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (!signatory.signer_name || !signatory.signer_email) {
        throw new Error("Add the signatory and email for the person who signs.");
      }
      const created = await api.createEntity(formPayload(form));
      if (signatory.signer_name && signatory.signer_email) {
        await api.saveBrokerSignatory(created.id, {
          ...signatory,
          id: signatoryId,
          company_name: signatory.company_name || created.display_name,
        });
      }
      const next = nextPath ? `?next=${encodeURIComponent(nextPath)}` : "";
      navigate(`/brokers/${created.id}${next}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function saveSignatory(event) {
    event.preventDefault();
    if (isNew) return;
    setBusy(true);
    setError("");
    try {
      const saved = await api.saveBrokerSignatory(id, {
        ...signatory,
        id: signatoryId,
        company_name: signatory.company_name || form.display_name,
      });
      setSignatoryId(saved.id);
      setSignatory({ ...saved, id: "" });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function onUpload(file, kind) {
    if (!file || isNew) return;
    setBusy(true);
    setError("");
    setSaveState("saving");
    try {
      await api.uploadEntityAsset(
        id,
        kind,
        file,
        file.name || `${form.display_name} ${kind}`
      );
      await load();
    } catch (err) {
      setSaveState("error");
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function confirmDeleteCompany() {
    setBusy(true);
    setError("");
    try {
      await api.deleteEntity(id);
      navigate("/brokers");
    } catch (err) {
      setError(err.message);
      setBusy(false);
      setPendingCompanyDelete(false);
    }
  }

  async function confirmDeleteAsset() {
    if (!pendingAsset) return;
    setBusy(true);
    setError("");
    setSaveState("saving");
    try {
      await api.deleteEntityAsset(id, pendingAsset.id);
      setPendingAsset(null);
      await load();
    } catch (err) {
      setSaveState("error");
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const activeAssets = (detail?.assets || []).filter(
    (asset) => asset.is_active && asset.kind !== "email_header"
  );
  const saveNote =
    saveState === "saving"
      ? "Saving…"
      : saveState === "saved"
        ? "All changes saved"
        : saveState === "error"
          ? "Could not save"
          : "";

  return (
    <div>
      <section className="hero-panel">
        <h1>{isNew ? "Add a broker" : form.display_name || "Broker setup"}</h1>
        <p>
          {tab === "compliance"
            ? `The compliance company sends the contract and the due diligence pack on behalf of ${form.display_name || "this broker"}.`
            : "Company details, the front cover, the back cover, and the brand SVG live here. They are applied to every contract this broker sends."}
          {!isNew ? " Company details save as you go." : ""}
        </p>
      </section>

      <div className="toolbar">
        <Link className="btn secondary" to="/brokers">
          All brokers
        </Link>
        {nextPath && !isNew ? (
          <Link
            className="btn"
            to={`${nextPath}${nextPath.includes("?") ? "&" : "?"}broker=${id}`}
          >
            Use this broker
          </Link>
        ) : null}
        {!isNew ? (
          <button
            type="button"
            className="btn danger"
            disabled={busy}
            onClick={() => setPendingCompanyDelete(true)}
          >
            Delete broker
          </button>
        ) : null}
      </div>

      <div className="setup-tabs" role="tablist" aria-label="Broker setup">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "company"}
          className={tab === "company" ? "is-active" : ""}
          onClick={() => selectTab("company")}
        >
          Details
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "compliance"}
          className={tab === "compliance" ? "is-active" : ""}
          onClick={() => selectTab("compliance")}
        >
          Compliance company
        </button>
      </div>

      {error ? <p className="error">{error}</p> : null}

      {tab === "company" ? (
      <>
      <form className="panel form-grid" onSubmit={isNew ? saveNew : (e) => e.preventDefault()}>
        {isNew ? (
          <label>
            Slug
            <input
              value={form.slug}
              onChange={(e) => setField("slug", e.target.value)}
              required
              placeholder="acme"
            />
          </label>
        ) : (
          <p className="meta">Slug: {form.slug}</p>
        )}
        <label>
          Display name
          <input
            value={form.display_name}
            onChange={(e) => setField("display_name", e.target.value)}
            placeholder="E Street Management"
            required
          />
        </label>
        <label>
          Legal name
          <input
            value={form.legal_name}
            onChange={(e) => setField("legal_name", e.target.value)}
            placeholder="Registered legal name"
            required
          />
        </label>
        <label>
          Company number
          <input
            value={form.company_number}
            onChange={(e) => setField("company_number", e.target.value)}
            placeholder="12345678"
            required
          />
        </label>
        <label>
          Registered office
          <input
            value={form.registered_office}
            onChange={(e) => setField("registered_office", e.target.value)}
            placeholder="Street, city, postcode"
            required
          />
        </label>
        {isNew ? (
          <button className="btn" type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save broker"}
          </button>
        ) : (
          <p className="muted">Company details save automatically.</p>
        )}
      </form>

      <form
        className="panel form-grid"
        style={{ marginTop: "1rem" }}
        onSubmit={isNew ? (event) => event.preventDefault() : saveSignatory}
      >
        <h2>Who signs for this broker</h2>
        <PartyFields
          value={signatory}
          onChange={(next) =>
            setSignatory((current) => (typeof next === "function" ? next(current) : next))
          }
        />
        {isNew ? (
          <p className="muted">Saved with the broker. The front cover, back cover, and brand SVG are added on the next screen.</p>
        ) : (
          <button className="btn" type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save signatory"}
          </button>
        )}
      </form>

      <p className="muted" style={{ marginTop: "1rem" }}>
        The introductory email is sent by the compliance company, on behalf of this broker.
      </p>

      {!isNew ? (
        <section className="panel form-grid" style={{ marginTop: "1rem" }}>
          <h2>Covers and brand</h2>
          <p className="muted">
            Front cover, back cover, and brand SVG. These are applied when a contract
            from this broker is prepared. Uploads and deletions save immediately.
          </p>
          <div className="brand-slots">
            <FileSlot
              label="Front cover"
              fileName={detail?.active_pack?.front?.name}
              mime={detail?.active_pack?.front?.mime}
              present={Boolean(detail?.active_pack?.front?.id)}
              previewUrl={
                detail?.active_pack?.front
                  ? api.entityAssetUrl(id, detail.active_pack.front.id)
                  : ""
              }
              accept=".pdf,.png,.jpg,.jpeg"
              busy={busy}
              uploadLabel="Upload file"
              onUpload={(file) => onUpload(file, "front_cover")}
              onDelete={
                detail?.active_pack?.front
                  ? () => setPendingAsset({ ...detail.active_pack.front, label: "Front cover" })
                  : null
              }
            />
            <FileSlot
              label="Back cover"
              fileName={detail?.active_pack?.back?.name}
              mime={detail?.active_pack?.back?.mime}
              present={Boolean(detail?.active_pack?.back?.id)}
              previewUrl={
                detail?.active_pack?.back
                  ? api.entityAssetUrl(id, detail.active_pack.back.id)
                  : ""
              }
              accept=".pdf,.png,.jpg,.jpeg"
              busy={busy}
              uploadLabel="Upload file"
              onUpload={(file) => onUpload(file, "back_cover")}
              onDelete={
                detail?.active_pack?.back
                  ? () => setPendingAsset({ ...detail.active_pack.back, label: "Back cover" })
                  : null
              }
            />
            <FileSlot
              label="Brand SVG"
              fileName={detail?.active_pack?.logo?.name}
              mime={detail?.active_pack?.logo?.mime}
              present={Boolean(detail?.active_pack?.logo?.id)}
              previewUrl={
                detail?.active_pack?.logo
                  ? api.entityAssetUrl(id, detail.active_pack.logo.id)
                  : ""
              }
              accept=".svg,.png,.jpg,.jpeg,.webp,image/svg+xml"
              busy={busy}
              uploadLabel="Upload file"
              onUpload={(file) => onUpload(file, "logo")}
              onDelete={
                detail?.active_pack?.logo
                  ? () => setPendingAsset({ ...detail.active_pack.logo, label: "Brand SVG" })
                  : null
              }
            />
          </div>
          <h3>Asset library</h3>
          {activeAssets.length ? (
            <ul className="audit-list asset-library">
              {activeAssets.map((asset) => (
                <li key={asset.id}>
                  <strong>
                    {KIND_LABELS[asset.kind] || asset.kind}
                  </strong>
                  <span>{asset.name}</span>
                  <button
                    type="button"
                    className="btn danger"
                    disabled={busy}
                    onClick={() =>
                      setPendingAsset({
                        ...asset,
                        label: KIND_LABELS[asset.kind] || asset.kind,
                      })
                    }
                  >
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No active files in the library.</p>
          )}
        </section>
      ) : null}
      </>
      ) : (
        <ComplianceCompany brokerName={form.display_name || "this broker"} embedded />
      )}

      {pendingCompanyDelete ? (
        <ConfirmDialog
          title="Are you sure?"
          message={`Delete ${form.display_name || "this broker"}? It will leave the broker list. Existing contracts stay on file.`}
          confirmLabel="Yes, delete broker"
          busy={busy}
          onCancel={() => (busy ? null : setPendingCompanyDelete(false))}
          onConfirm={confirmDeleteCompany}
        />
      ) : null}

      {pendingAsset ? (
        <ConfirmDialog
          title="Are you sure?"
          message={`Delete ${pendingAsset.label || "this file"} (${pendingAsset.name || "untitled"})? It will leave the brand pack. Existing contracts stay on file.`}
          confirmLabel="Yes, delete file"
          busy={busy}
          onCancel={() => (busy ? null : setPendingAsset(null))}
          onConfirm={confirmDeleteAsset}
        />
      ) : null}

      {!isNew && saveNote ? (
        <div
          className={`save-status ${saveState}`}
          role="status"
          aria-live="polite"
        >
          {saveNote}
        </div>
      ) : null}
    </div>
  );
}

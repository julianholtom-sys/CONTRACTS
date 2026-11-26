import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api.js";

export default function EnvelopeDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [envelope, setEnvelope] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [links, setLinks] = useState({});
  const [nameDraft, setNameDraft] = useState({});
  const [checks, setChecks] = useState({});
  const [companyDates, setCompanyDates] = useState({});
  const [pepDraft, setPepDraft] = useState({});

  async function reload() {
    const data = await api.getEnvelope(id);
    setEnvelope(data);
    const next = {};
    const byCompany = {};
    for (const doc of data.due_diligence?.documents || []) {
      const value = { receivedOn: doc.receivedOn || "", checkedOn: doc.checkedOn || "" };
      next[doc.key] = value;
      const shared = byCompany[doc.roleKey];
      if (!shared) byCompany[doc.roleKey] = { ...value };
      else {
        if (shared.receivedOn !== value.receivedOn) shared.receivedOn = "";
        if (shared.checkedOn !== value.checkedOn) shared.checkedOn = "";
      }
    }
    setChecks(next);
    setCompanyDates(byCompany);
  }

  useEffect(() => {
    reload().catch((err) => setError(err.message));
  }, [id]);

  async function run(action, fn) {
    setBusy(action);
    setError("");
    try {
      await fn();
      await reload();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  if (!envelope && !error) return <p className="muted">Loading contract…</p>;
  if (!envelope) return <p className="error">{error}</p>;

  const diligence = envelope.due_diligence;
  const issueBlocked = Boolean(diligence?.applies && !diligence.validatedAt);
  const ddLocked = Boolean(diligence?.validatedAt) || !["draft", "ready"].includes(envelope.status);
  const undatedCount = (diligence?.missing || []).filter((item) => item.includes("received and checked dates")).length;
  const otherMissing = (diligence?.missing || []).filter((item) => !item.includes("received and checked dates"));
  const datedCompanies = (diligence?.records || []).filter((record) =>
    (diligence.documents || []).some((doc) => doc.roleKey === record.roleKey)
  );
  const companyDated = (roleKey) => Boolean(companyDates[roleKey]?.receivedOn && companyDates[roleKey]?.checkedOn);

  function saveChecks(values) {
    return api.saveDueDiligenceChecks(
      id,
      (diligence.documents || []).map((doc) => ({
        key: doc.key,
        receivedOn: values[doc.key]?.receivedOn || "",
        checkedOn: values[doc.key]?.checkedOn || "",
      }))
    );
  }

  return (
    <div>
      <section className="hero-panel">
        <h1>
          {envelope.title}{" "}
          {envelope.is_sample ? <span className="badge draft">Sample</span> : null}
        </h1>
        <p>
          {envelope.entity?.display_name} ·{" "}
          <span className={`badge ${envelope.status}`}>{envelope.status}</span>
          {envelope.industry ? <span className="muted"> · {envelope.industry}</span> : null}
          {envelope.baked_hash ? (
            <span className="muted"> · bake {envelope.baked_hash.slice(0, 12)}…</span>
          ) : null}
        </p>
        <p className="meta">
          Prepared {envelope.prepared_on || "—"} · Issued{" "}
          {envelope.issued_at ? String(envelope.issued_at).slice(0, 10) : "on send"}
        </p>
        {envelope.is_sample ? (
          <p className="muted">
            Bailey, Northwind, Casey and Nina North are examples used to fill fields for testing.
          </p>
        ) : null}
        {envelope.status === "completed" ? (
          <p className="muted">
            The completed PDF binds every requested attachment. Every party receives
            that same bound copy.
          </p>
        ) : null}
      </section>

      {envelope.bake_error ? <p className="error">Bake error: {envelope.bake_error}</p> : null}
      {error ? <p className="error">{error}</p> : null}

      <div className="toolbar">
        <button
          className="btn"
          type="button"
          disabled={busy || !["draft", "ready"].includes(envelope.status)}
          onClick={() => run("bake", () => api.bakeEnvelope(id))}
        >
          {busy === "bake" ? "Baking…" : envelope.status === "ready" ? "Bake again" : "Bake"}
        </button>
        <button
          className="btn secondary"
          type="button"
          disabled={busy || envelope.status !== "ready" || issueBlocked}
          onClick={() => run("send", () => api.sendEnvelope(id))}
        >
          {busy === "send" ? "Sending…" : "Send first invitation"}
        </button>
        {envelope.baked_document_id ? (
          <a className="btn secondary" href={api.documentUrl(id, "baked")} target="_blank" rel="noreferrer">
            Open baked PDF
          </a>
        ) : null}
        {envelope.status === "completed" ? (
          <a className="btn secondary" href={api.documentUrl(id, "completed")} target="_blank" rel="noreferrer">
            Completed PDF
          </a>
        ) : null}
        <button
          className="btn danger"
          type="button"
          disabled={busy || ["completed", "declined", "voided", "expired"].includes(envelope.status)}
          onClick={() =>
            run("void", () => api.voidEnvelope(id, "Voided from staff console"))
          }
        >
          Void
        </button>
      </div>

      {diligence?.applies ? (
        <section className="panel" style={{ marginBottom: "1.25rem" }}>
          <h2>Due diligence pack</h2>
          <p className="muted">Date each document, compile, then sign.</p>
          {diligence.validatedAt ? (
            <p className="meta">
              Broker signed {new Date(diligence.validatedAt).toLocaleString("en-GB")}
              {diligence.signedName ? ` · ${diligence.signedName}` : ""}.
            </p>
          ) : diligence.compiledAt ? (
            <p className="meta">
              Compiled {new Date(diligence.compiledAt).toLocaleString("en-GB")}. Waiting
              for the broker to sign.
            </p>
          ) : (
            <p className="meta">Not compiled yet.</p>
          )}
          {diligence.missing?.length > 0 && !diligence.validatedAt ? (
            <ul className="audit-list">
              {otherMissing.map((item) => (
                <li key={item}>
                  <strong>Still needed</strong>
                  <span>{item}</span>
                </li>
              ))}
              {undatedCount ? (
                <li>
                  <strong>Still needed</strong>
                  <span>
                    Received and checked dates for {undatedCount} document{undatedCount === 1 ? "" : "s"}
                  </span>
                </li>
              ) : null}
            </ul>
          ) : null}
          {diligence.records?.map((record) => (
            <p key={record.roleKey} className="meta">
              {record.label}: {record.companyName || "Not saved"}
              {record.href ? (
                <>
                  {" "}
                  <Link to={record.href}>Open the record</Link>
                </>
              ) : null}
            </p>
          ))}
          {diligence.documents?.length && !diligence.validatedAt ? (
            <div className="party-card" style={{ marginTop: "1rem" }}>
              <h3>Dates by company</h3>
              {datedCompanies.map((record) => {
                const value = companyDates[record.roleKey] || { receivedOn: "", checkedOn: "" };
                const update = (field) => (e) =>
                  setCompanyDates((current) => ({ ...current, [record.roleKey]: { ...value, [field]: e.target.value } }));
                return (
                  <div key={record.roleKey}>
                    <strong>
                      {record.label}
                      {record.companyName ? ` · ${record.companyName}` : ""}
                    </strong>
                    <div className="signer-row">
                      <label>
                        Received
                        <input type="date" value={value.receivedOn} onChange={update("receivedOn")} />
                      </label>
                      <label>
                        Checked
                        <input type="date" value={value.checkedOn} onChange={update("checkedOn")} />
                      </label>
                    </div>
                  </div>
                );
              })}
              <button
                type="button"
                className="btn secondary"
                disabled={Boolean(busy) || !datedCompanies.some((record) => companyDated(record.roleKey))}
                onClick={() =>
                  run("company-dates", () =>
                    saveChecks(
                      Object.fromEntries(
                        (diligence.documents || []).map((doc) => [
                          doc.key,
                          companyDated(doc.roleKey) ? { ...companyDates[doc.roleKey] } : checks[doc.key],
                        ])
                      )
                    )
                  )
                }
              >
                {busy === "company-dates" ? "Saving…" : "Apply to each company’s documents and save"}
              </button>
              <p className="muted">Edit any document below that differs.</p>
            </div>
          ) : null}
          {diligence.documents?.length ? (
            <div className="form-grid">
              {diligence.documents.map((doc) => {
                const value = checks[doc.key] || { receivedOn: "", checkedOn: "" };
                return (
                  <div key={doc.key}>
                    <strong>
                      {doc.roleLabel}: {doc.label}
                    </strong>
                    <div className="signer-row">
                      <label>
                        Received
                        <input
                          type="date"
                          value={value.receivedOn}
                          onChange={(e) =>
                            setChecks((current) => ({
                              ...current,
                              [doc.key]: { ...value, receivedOn: e.target.value },
                            }))
                          }
                        />
                      </label>
                      <label>
                        Checked
                        <input
                          type="date"
                          value={value.checkedOn}
                          onChange={(e) =>
                            setChecks((current) => ({
                              ...current,
                              [doc.key]: { ...value, checkedOn: e.target.value },
                            }))
                          }
                        />
                      </label>
                    </div>
                  </div>
                );
              })}
              <button
                type="button"
                className="btn secondary"
                disabled={Boolean(busy)}
                onClick={() => run("dates", () => saveChecks(checks))}
              >
                {busy === "dates" ? "Saving…" : "Save received and checked dates"}
              </button>
            </div>
          ) : null}
          {diligence.sections.filter((section) => !section.heldOnRecord).map((section) => {
            const draft = nameDraft[section.roleKey] || { previousName: "", newName: "" };
            return (
              <div className="party-card" key={section.roleKey} style={{ marginTop: "1rem" }}>
                <h3>
                  {section.label}
                  {section.companyName ? ` · ${section.companyName}` : ""}{" "}
                  <span className={`badge ${section.submittedAt ? "completed" : "draft"}`}>
                    {section.submittedAt ? "submitted" : "not submitted"}
                  </span>
                </h3>
                {section.roleKey === "company" ? (
                  <p className="muted">Add a certificate for each name change, if any.</p>
                ) : null}
                {section.roleKey === "supplier" ? (
                  <label className="consent">
                    <input
                      type="checkbox"
                      checked={Boolean(section.officeChanged)}
                      onChange={(e) =>
                        run("office", () => api.setOfficeChanged(id, e.target.checked))
                      }
                    />
                    <span>Registered office has changed</span>
                  </label>
                ) : null}
                <div className="form-grid">
                  {section.items
                    .filter((item) => item.required || item.key === "registered_office")
                    .map((item) => (
                      <div key={item.key}>
                        <strong>
                          {item.label}{" "}
                          {item.required ? (
                            <span className={`badge ${item.satisfied ? "completed" : "sent"}`}>
                              {item.satisfied ? "in pack" : "needed"}
                            </span>
                          ) : (
                            <span className="muted">not requested</span>
                          )}
                        </strong>
                        {item.file ? <p className="meta">{item.file.original_name}</p> : null}
                        {item.required || section.officeChanged ? (
                          <label className="muted">
                            Upload
                            <input
                              type="file"
                              accept=".pdf,.png,.jpg,.jpeg"
                              onChange={(e) => {
                                const file = e.target.files?.[0];
                                e.target.value = "";
                                if (!file) return;
                                run(`file-${section.roleKey}-${item.key}`, () =>
                                  api.uploadDueDiligence(id, {
                                    roleKey: section.roleKey,
                                    requirementKey: item.key,
                                    file,
                                  })
                                );
                              }}
                            />
                          </label>
                        ) : null}
                      </div>
                    ))}
                </div>
                {section.nameChanges.map((change) => (
                  <div key={change.id} style={{ marginTop: "0.75rem" }}>
                    <strong>
                      {change.label}{" "}
                      <span className={`badge ${change.satisfied ? "completed" : "sent"}`}>
                        {change.satisfied ? "in pack" : "needed"}
                      </span>
                    </strong>
                    {change.file ? <p className="meta">{change.file.original_name}</p> : null}
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
                            run(`change-${change.id}`, () =>
                              api.uploadDueDiligence(id, {
                                roleKey: section.roleKey,
                                nameChangeId: change.id,
                                file,
                              })
                            );
                          }}
                        />
                      </label>
                      <button
                        type="button"
                        className="btn secondary"
                        onClick={() => run(`drop-${change.id}`, () => api.removeNameChange(id, change.id))}
                      >
                        Remove change
                      </button>
                    </div>
                  </div>
                ))}
                <div className="signer-row" style={{ marginTop: "0.75rem" }}>
                  <label>
                    Previous name
                    <input
                      value={draft.previousName}
                      placeholder="Name before the change"
                      onChange={(e) =>
                        setNameDraft((prev) => ({
                          ...prev,
                          [section.roleKey]: { ...draft, previousName: e.target.value },
                        }))
                      }
                    />
                  </label>
                  <label>
                    New name
                    <input
                      value={draft.newName}
                      placeholder="Name after the change"
                      onChange={(e) =>
                        setNameDraft((prev) => ({
                          ...prev,
                          [section.roleKey]: { ...draft, newName: e.target.value },
                        }))
                      }
                    />
                  </label>
                  <button
                    type="button"
                    className="btn secondary"
                    onClick={() =>
                      run(`add-${section.roleKey}`, async () => {
                        await api.addNameChange(id, {
                          roleKey: section.roleKey,
                          previousName: draft.previousName,
                          newName: draft.newName,
                        });
                        setNameDraft((prev) => ({
                          ...prev,
                          [section.roleKey]: { previousName: "", newName: "" },
                        }));
                      })
                    }
                  >
                    Add name change
                  </button>
                </div>
              </div>
            );
          })}
          <div className="party-card" style={{ marginTop: "1rem" }}>
            <h3>Review</h3>
            <label>
              Review frequency
              <select
                value={diligence.reviewFrequency}
                disabled={Boolean(busy) || ddLocked}
                onChange={(e) => run("settings", () => api.saveDiligenceSettings(id, { reviewFrequency: e.target.value }))}
              >
                <option value="monthly">Monthly</option>
                <option value="quarterly">Quarterly</option>
              </select>
            </label>
          </div>
          <div className="party-card" style={{ marginTop: "1rem" }}>
            <h3>PEP and adverse media screening</h3>
            {(diligence.records || []).map((record) => {
              const people = (diligence.pep || []).filter((row) => row.roleKey === record.roleKey);
              if (!people.length) return null;
              return (
                <div key={record.roleKey} style={{ marginTop: "0.5rem" }}>
                  <strong>
                    {record.label} · {record.companyName}
                  </strong>
                  {people.map((person) => {
                    const draftKey = `${person.roleKey}:${person.personKey}`;
                    const draftResult = pepDraft[draftKey] || person.result || "clear";
                    return (
                      <div key={draftKey} className="toolbar" style={{ marginTop: "0.4rem", alignItems: "center" }}>
                        <span>
                          {person.name} <span className="muted">({person.roles.join(" and ")})</span>
                        </span>
                        {person.verified == null ? (
                          <span className="badge draft">ID not checked</span>
                        ) : person.verified ? (
                          <span className="badge completed">ID verified</span>
                        ) : (
                          <span className="badge sent">
                            ID not verified
                            {person.verificationDueOn ? `, due ${ukDay(person.verificationDueOn)}` : ""}
                          </span>
                        )}
                        {person.approvedOn ? (
                          <>
                            <span className={`badge ${person.result === "flag" ? "sent" : "completed"}`}>
                              {person.result === "flag" ? "Flag" : "Clear"}
                            </span>
                            <span className="meta">
                              Approved by {person.approvedBy} on {ukDay(person.approvedOn)}
                            </span>
                            <button
                              type="button"
                              className="btn secondary"
                              disabled={Boolean(busy) || ddLocked}
                              onClick={() =>
                                run(`pep-${draftKey}`, () =>
                                  api.savePepCheck(id, {
                                    roleKey: person.roleKey,
                                    personKey: person.personKey,
                                    result: person.result,
                                    approved: false,
                                  })
                                )
                              }
                            >
                              Undo
                            </button>
                          </>
                        ) : (
                          <>
                            <select
                              value={draftResult}
                              disabled={Boolean(busy) || ddLocked}
                              onChange={(e) => setPepDraft((prev) => ({ ...prev, [draftKey]: e.target.value }))}
                            >
                              <option value="clear">Clear</option>
                              <option value="flag">Flag</option>
                            </select>
                            <button
                              type="button"
                              className="btn"
                              disabled={Boolean(busy) || ddLocked}
                              onClick={() =>
                                run(`pep-${draftKey}`, () =>
                                  api.savePepCheck(id, {
                                    roleKey: person.roleKey,
                                    personKey: person.personKey,
                                    result: draftResult,
                                  })
                                )
                              }
                            >
                              Approve
                            </button>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
            {!(diligence.pep || []).length ? (
              <p className="meta">No directors or PSCs found. Fetch Companies House on each company record.</p>
            ) : null}
          </div>
          <div className="party-card" style={{ marginTop: "1rem" }}>
            <h3>Worker arrangements</h3>
            <div className="signer-row">
              <label>
                Worker type
                <select
                  value={diligence.workerType}
                  disabled={Boolean(busy) || ddLocked}
                  onChange={(e) => run("settings", () => api.saveDiligenceSettings(id, { workerType: e.target.value }))}
                >
                  <option value="regular">Regular hours</option>
                  <option value="irregular">Irregular hours</option>
                  <option value="part_year">Part-year</option>
                </select>
              </label>
              <label>
                Holiday pay
                <select
                  value={diligence.holidayMethod}
                  disabled={Boolean(busy) || ddLocked}
                  onChange={(e) => run("settings", () => api.saveDiligenceSettings(id, { holidayMethod: e.target.value }))}
                >
                  <option value="taken">Paid when taken</option>
                  <option value="rolled_up" disabled={diligence.workerType === "regular"}>
                    Rolled up at 12.07%
                  </option>
                </select>
              </label>
            </div>
            {diligence.workerType === "regular" ? (
              <p className="meta">Rolled-up holiday pay is only for irregular-hours or part-year workers.</p>
            ) : null}
            {(diligence.worker || []).map((row) => (
              <div key={row.key} style={{ marginTop: "0.75rem" }}>
                <strong>{row.label}</strong>
                <p className="muted" style={{ margin: "0.2rem 0" }}>
                  {row.text}
                </p>
                <label className="consent">
                  <input
                    type="checkbox"
                    checked={row.confirmed}
                    disabled={Boolean(busy) || ddLocked}
                    onChange={(e) =>
                      run(`worker-${row.key}`, () =>
                        api.confirmWorkerArrangement(id, { topic: row.key, confirmed: e.target.checked })
                      )
                    }
                  />
                  <span>
                    Confirmed
                    {row.confirmed && row.confirmedBy ? ` · ${row.confirmedBy}, ${ukDay(row.confirmedOn)}` : ""}
                  </span>
                </label>
              </div>
            ))}
          </div>
          {diligence.blockers?.length && !diligence.validatedAt ? (
            <ul className="audit-list" style={{ marginTop: "1rem" }}>
              {diligence.blockers.map((item) => (
                <li key={item}>
                  <strong>Before signing</strong>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="toolbar" style={{ marginTop: "1rem" }}>
            <button
              type="button"
              className="btn"
              disabled={busy || !diligence.readyToCompile || Boolean(diligence.validatedAt)}
              onClick={() => run("compile", () => api.compileDueDiligence(id))}
            >
              {busy === "compile" ? "Compiling…" : "Compile the pack"}
            </button>
            {diligence.hasFile && !diligence.validatedAt ? (
              <button
                type="button"
                className="btn secondary"
                disabled={Boolean(busy) || Boolean(diligence.blockers?.length)}
                onClick={() =>
                  run("sign", async () => {
                    const result = await api.dueDiligenceSignLink(id);
                    navigate(result.path);
                  })
                }
              >
                {busy === "sign" ? "Opening…" : "Sign the pack"}
              </button>
            ) : null}
            {diligence.hasFile ? (
              <a className="btn secondary" href={api.dueDiligenceUrl(id)} target="_blank" rel="noreferrer">
                Open due diligence pack
              </a>
            ) : null}
          </div>
          {issueBlocked ? (
            <p className="muted">
              Send stays unavailable until the broker has signed this pack.
            </p>
          ) : (
            <p className="muted">
              The signed pack is added to the contract as an extra document when the contract is sent.
            </p>
          )}
        </section>
      ) : null}

      <section className="panel" style={{ marginBottom: "1.25rem" }}>
        <h2>Auto-applied pack</h2>
        <ul className="audit-list">
          <li>
            <strong>Front cover</strong>
            <span>{envelope.auto_pack?.front?.name || "—"}</span>
          </li>
          <li>
            <strong>Back cover</strong>
            <span>{envelope.auto_pack?.back?.name || "—"}</span>
          </li>
          <li>
            <strong>Logo</strong>
            <span>{envelope.auto_pack?.logo?.name || "—"}</span>
          </li>
          <li>
            <strong>Appendices</strong>
            <span>
              {(envelope.auto_pack?.appendices || []).map((a) => a.name).join(", ") || "—"}
            </span>
          </li>
        </ul>
      </section>

      <div className="split">
        <section className="panel">
          <h2>Parties</h2>
          <div className="form-grid">
            {envelope.parties.map((party) => (
              <div className="party-card" key={party.id}>
                <div className="toolbar" style={{ margin: 0 }}>
                  <strong>
                    {party.role_label} · {party.signer_name}
                  </strong>
                  <span className={`badge ${party.status}`}>{party.status}</span>
                </div>
                <p className="meta">
                  {party.company_name} ·{" "}
                  {party.signer_role === "authorised_signatory"
                    ? "Authorised signatory"
                    : party.signer_role === "director"
                      ? "Director"
                      : "Role not recorded"}{" "}
                  · {party.signer_email}
                  {party.is_sample ? " · Sample" : ""}
                </p>
                <p className="muted">Signs at step {party.order_index}</p>
                {party.evidence_required ? (
                  <p className="muted">Final evidence appendix required before sign</p>
                ) : (
                  <p className="muted">No final evidence appendix</p>
                )}
                <button
                  type="button"
                  className="btn secondary"
                  onClick={() =>
                    run(`link-${party.id}`, async () => {
                      const result = await api.partyLink(id, party.id);
                      setLinks((prev) => ({ ...prev, [party.id]: result.signingLink }));
                    })
                  }
                >
                  Mint / resend link
                </button>
                {links[party.id] ? (
                  <p className="meta">
                    <a href={links[party.id]}>Open signing room</a>
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        </section>

        <section className="panel">
          <h2>Local email outbox</h2>
          <ul className="audit-list">
            {(envelope.emails || []).map((mail) => (
              <li key={mail.id}>
                <strong>{mail.template_type}</strong>
                <span className="muted">{mail.to_address}</span>
                <span>{mail.subject}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

function ukDay(iso) {
  return iso ? String(iso).slice(0, 10).split("-").reverse().join("/") : "";
}

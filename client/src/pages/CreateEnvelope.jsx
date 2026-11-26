import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api.js";
import { emptyParty, PartyFields } from "../PartyFields.jsx";

function mergeParty(setter) {
  return (next) => setter((current) => (typeof next === "function" ? next(current) : next));
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function sampleMark(row) {
  return row?.is_sample ? " (sample)" : "";
}

export default function CreateEnvelope() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const mode = params.get("from") === "library" ? "library" : "new";
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState(0);
  const [brokers, setBrokers] = useState([]);
  const [contractors, setContractors] = useState([]);
  const [clients, setClients] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [library, setLibrary] = useState([]);
  const [entities, setEntities] = useState([]);
  const [broker, setBroker] = useState(null);
  const appliedBroker = useRef(false);
  const [libraryItem, setLibraryItem] = useState(null);
  const [contracts, setContracts] = useState(null);
  const [scheduleIds, setScheduleIds] = useState([]);
  const [shape, setShape] = useState("");
  const [contractor, setContractor] = useState(emptyParty());
  const [client, setClient] = useState(emptyParty());
  const [supplier, setSupplier] = useState(emptyParty());

  useEffect(() => {
    Promise.all([
      api.directory("broker"),
      api.directory("contractor"),
      api.directory("client"),
      api.directory("supplier"),
      api.library(),
      api.bootstrap(),
    ])
      .then(([brokerRows, contractorRows, clientRows, supplierRows, libraryRows, boot]) => {
        setBrokers(brokerRows);
        setContractors(contractorRows);
        setClients(clientRows);
        setSuppliers(supplierRows);
        setLibrary(libraryRows);
        setEntities(boot.entities || []);
        setReady(true);
      })
      .catch((err) => setError(err.message));
  }, []);

  const contractEntityId =
    mode === "library" ? libraryItem?.entity_id : broker ? broker.entity_id || entities[0]?.id : null;
  useEffect(() => {
    setContracts(null);
    if (!contractEntityId) return;
    api
      .brokerContracts(contractEntityId)
      .then(setContracts)
      .catch((err) => setError(err.message));
  }, [contractEntityId]);

  const schedulesFor = (choice) =>
    (contracts?.schedules || []).filter((item) => !item.party_shape || item.party_shape === choice);
  const contractFor = (choice) => contracts?.masters?.[choice] || contracts?.placeholder || null;

  const presetBrokerId = params.get("broker") || "";
  const brokerSetup = (entityId) => {
    const base = entityId ? `/brokers/${entityId}` : "/brokers/new";
    return `${base}?next=${encodeURIComponent("/new?from=new")}`;
  };

  useEffect(() => {
    if (!ready || appliedBroker.current || !presetBrokerId) return;
    const signer = brokers.find((row) => row.entity_id === presetBrokerId);
    if (!signer) return;
    appliedBroker.current = true;
    setBroker(signer);
    setStep(1);
  }, [ready, presetBrokerId, brokers]);

  const steps =
    mode === "library"
      ? ["Library", "3-way or 4-way", "Schedules", "Other parties"]
      : ["Broker", "3-way or 4-way", "Schedules", "Other parties"];
  const onShape = step === 1;
  const onSchedules = step === 2;
  const onParties = step === steps.length - 1;

  function chooseShape(choice) {
    setShape(choice);
    setScheduleIds(schedulesFor(choice).map((item) => item.id));
    setStep(2);
  }

  function back() {
    setError("");
    if (step === 0) {
      navigate("/");
      return;
    }
    setStep((current) => current - 1);
  }

  function chooseBroker(row) {
    setBroker(row);
    setStep(1);
  }

  async function onSubmit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      let libraryId = libraryItem?.id || "";
      if (mode === "new") {
        const entityId = broker.entity_id || entities[0]?.id;
        const existing = library.find(
          (item) =>
            item.entity_id === entityId &&
            item.broker.signer_email === broker.signer_email &&
            item.broker.company_name === broker.company_name &&
            item.contractor.signer_email === contractor.signer_email &&
            item.contractor.company_name === contractor.company_name
        );
        if (existing) {
          libraryId = existing.id;
        } else {
          const saved = await api.saveLibrary({
            name: `${broker.company_name} / ${contractor.company_name}`,
            entityId,
            broker: { ...broker, entityId },
            contractor,
          });
          libraryId = saved.id;
        }
      }
      const envelope = await api.createEnvelope({
        libraryId,
        title: client.company_name,
        preparedOn: todayISO(),
        client,
        supplier: shape === "four" ? supplier : null,
        appendixIds: scheduleIds,
      });
      navigate(`/envelopes/${envelope.id}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!ready && !error) return <p className="muted">Loading…</p>;

  return (
    <div>
      <button className="btn secondary wizard-back" type="button" onClick={back}>
        Back
      </button>
      <section className="hero-panel">
        <p className="muted">
          Step {Math.min(step + 1, steps.length)} of {steps.length}
        </p>
        <h1>{heading(mode, step)}</h1>
      </section>

      {error ? <p className="error">{error}</p> : null}

      {mode === "library" && step === 0 ? (
        library.length ? (
          <div className="choice-grid">
            {library.map((item) => (
              <button
                key={item.id}
                type="button"
                className="choice-card"
                onClick={() => {
                  setLibraryItem(item);
                  setStep(1);
                }}
              >
                <strong>
                  {item.name}
                  {sampleMark(item)}
                </strong>
                <span>
                  {item.broker.company_name} and {item.contractor.company_name}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="empty">
            Nothing is saved in the library yet.{" "}
            <Link to="/new?from=new">Send a new contract</Link> instead.
          </div>
        )
      ) : null}

      {mode === "new" && step === 0 ? (
        <div className="choice-grid">
          {entities.map((entity) => {
            const signer = brokers.find((row) => row.entity_id === entity.id);
            return (
              <div key={entity.id} className="choice-card">
                <button
                  type="button"
                  className="choice-hit"
                  onClick={() => (signer ? chooseBroker(signer) : navigate(brokerSetup(entity.id)))}
                >
                  <strong>
                    {entity.display_name}
                    {sampleMark(signer)}
                  </strong>
                  <span>
                    {signer
                      ? `${signer.signer_name} · ${signer.signer_email}`
                      : "Signatory not set yet"}
                  </span>
                </button>
                <Link to={brokerSetup(entity.id)}>Covers, brand SVG and company details</Link>
              </div>
            );
          })}
          <Link className="choice-card" to={brokerSetup()}>
            <strong>Add a broker</strong>
            <span>Company details, front cover, back cover, and brand SVG.</span>
          </Link>
        </div>
      ) : null}

      {onShape ? (
        contracts ? (
          <>
          <div className="choice-grid">
            {[
              ["three", "3-way", "Contractor, broker and client. This is the usual contract."],
              ["four", "4-way", "Those three, plus a supplier."],
            ].map(([choice, label, text]) => {
              const contract = contractFor(choice);
              return (
                <button
                  key={choice}
                  type="button"
                  className="choice-card"
                  disabled={!contract}
                  onClick={() => chooseShape(choice)}
                >
                  <strong>{label}</strong>
                  <span>{text}</span>
                  <span className={contract?.is_placeholder || !contract ? "error" : "meta"}>
                    {!contract
                      ? `No ${label} contract uploaded for this broker`
                      : contract.is_placeholder
                        ? `No ${label} contract uploaded for this broker yet: uses the placeholder`
                        : contract.name}
                  </span>
                </button>
              );
            })}
          </div>
          <p className="muted">
            <Link to={`/brokers/${contractEntityId}`}>This broker’s contracts and schedules</Link>
          </p>
          </>
        ) : (
          <p className="muted">Loading…</p>
        )
      ) : null}

      {onSchedules ? (
        <div className="panel form-grid">
          {schedulesFor(shape).length ? (
            schedulesFor(shape).map((item) => (
              <label key={item.id} className="consent">
                <input
                  type="checkbox"
                  checked={scheduleIds.includes(item.id)}
                  onChange={(e) =>
                    setScheduleIds((current) =>
                      e.target.checked ? [...current, item.id] : current.filter((value) => value !== item.id)
                    )
                  }
                />
                <span>{item.name}</span>
              </label>
            ))
          ) : (
            <p className="muted">
              This broker has no {shape === "four" ? "4-way" : "3-way"} schedules.{" "}
              <Link to={`/brokers/${contractEntityId}`}>Add one</Link>
            </p>
          )}
          <button className="btn" type="button" onClick={() => setStep(3)}>
            Continue
          </button>
        </div>
      ) : null}

      {onParties ? (
        <form className="panel form-grid" onSubmit={onSubmit}>
          {mode === "library" && libraryItem ? (
            <p className="muted">
              {libraryItem.broker.company_name} and {libraryItem.contractor.company_name} are already on this
              contract.
            </p>
          ) : null}
          {mode === "new" ? (
            <section className="party-card">
              <h3>Contractor</h3>
              <PartyFields
                value={contractor}
                onChange={mergeParty(setContractor)}
                records={contractors}
                showCompanyNumber
              />
              <p className="muted">
                VAT, insurance, bank, payslip and payroll chain documents, the signature and the director ID are on the
                contractor record.
              </p>
            </section>
          ) : null}
          <section className="party-card">
            <h3>Client</h3>
            <PartyFields value={client} onChange={mergeParty(setClient)} records={clients} lookup />
            <p className="muted">
              The client is the only party sent a link. It uploads its incorporation certificate, VAT certificate and
              director ID when signing.
            </p>
          </section>
          {shape === "four" ? (
            <section className="party-card">
              <h3>Supplier</h3>
              <PartyFields
                value={supplier}
                onChange={mergeParty(setSupplier)}
                records={suppliers}
                showCompanyNumber
              />
              <p className="muted">
                The PAYE letter, the Employers’ Liability documents, the signature and the director ID are added on the
                supplier record.
              </p>
            </section>
          ) : null}
          <button className="btn" type="submit" disabled={busy}>
            {busy ? "Creating…" : "Create draft contract"}
          </button>
        </form>
      ) : null}
    </div>
  );
}

function heading(mode, step) {
  if (mode === "library") {
    return ["Which library template?", "Is this 3-way or 4-way?", "Which schedules?", "Who else signs?"][step];
  }
  return ["Which broker?", "Is this 3-way or 4-way?", "Which schedules?", "Who else signs?"][step];
}

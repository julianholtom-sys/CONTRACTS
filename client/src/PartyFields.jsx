import { useState } from "react";
import { api } from "./api.js";

export const SIGNER_ROLES = [
  ["director", "Director"],
  ["authorised_signatory", "Authorised signatory"],
];

export function emptyParty() {
  return {
    id: "",
    company_name: "",
    signer_name: "",
    signer_role: "director",
    signer_email: "",
    company_number: "",
    registered_office: "",
    entity_id: "",
  };
}

export function PartyFields({
  value,
  onChange,
  records = [],
  disabled = false,
  showCompanyNumber = false,
  lookup = false,
}) {
  const [found, setFound] = useState(null);
  const [looking, setLooking] = useState(false);
  const [lookupError, setLookupError] = useState("");

  function update(partial) {
    onChange((current) => ({ ...current, ...partial, id: "" }));
  }

  function pick(id) {
    setFound(null);
    if (!id) {
      onChange(emptyParty());
      return;
    }
    const match = records.find((row) => row.id === id);
    if (match) onChange({ ...match });
  }

  async function fillFromCompaniesHouse() {
    setLooking(true);
    setLookupError("");
    try {
      const company = await api.companyLookup(value.company_number);
      setFound(company);
      update({
        company_number: company.companyNumber,
        company_name: company.legalName || value.company_name,
        registered_office: company.registeredOffice || "",
        ...(company.directors.length === 1
          ? { signer_name: company.directors[0].name, signer_role: "director" }
          : {}),
      });
    } catch (err) {
      setFound(null);
      setLookupError(err.message);
    } finally {
      setLooking(false);
    }
  }

  const locked = disabled || Boolean(value.id);

  return (
    <div className="stack">
      {records.length ? (
        <label>
          Use a saved record
          <select value={value.id || ""} onChange={(e) => pick(e.target.value)} disabled={disabled}>
            <option value="">Enter a new record</option>
            {records.map((row) => (
              <option key={row.id} value={row.id}>
                {row.company_name} — {row.signer_name}
                {row.is_sample ? " (sample)" : ""}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <div className="signer-row">
        {showCompanyNumber || lookup ? (
          <label>
            Company number
            <input
              value={value.company_number || ""}
              onChange={(e) => update({ company_number: e.target.value })}
              placeholder="12345678"
              disabled={locked}
            />
          </label>
        ) : null}
        {lookup && !locked ? (
          <div className="lookup-action">
            <button
              type="button"
              className="btn secondary"
              disabled={looking || !String(value.company_number || "").trim()}
              onClick={fillFromCompaniesHouse}
            >
              {looking ? "Looking up…" : "Fill from Companies House"}
            </button>
          </div>
        ) : null}
        <label>
          Company name
          <input
            value={value.company_name}
            onChange={(e) => update({ company_name: e.target.value })}
            placeholder="Registered company name"
            required
            disabled={locked}
          />
        </label>
        {found?.directors?.length > 1 && !locked ? (
          <label>
            Director at Companies House
            <select
              value=""
              onChange={(e) => e.target.value && update({ signer_name: e.target.value, signer_role: "director" })}
            >
              <option value="">Choose a director to sign</option>
              {found.directors.map((director) => (
                <option key={director.name} value={director.name}>
                  {director.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label>
          Signatory
          <input
            value={value.signer_name}
            onChange={(e) => update({ signer_name: e.target.value })}
            placeholder="Person who will sign"
            required
            disabled={locked}
          />
        </label>
        <label>
          Role in the company
          <select
            value={value.signer_role}
            onChange={(e) => update({ signer_role: e.target.value })}
            required
            disabled={locked}
          >
            {SIGNER_ROLES.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Email
          <input
            type="email"
            value={value.signer_email}
            onChange={(e) => update({ signer_email: e.target.value })}
            placeholder="name@company.com"
            required
            disabled={locked}
          />
        </label>
      </div>
      {lookupError ? <p className="error">{lookupError}</p> : null}
      {lookup && (found || value.registered_office) ? (
        <p className="meta">
          {[found?.status, value.registered_office ? `Registered office: ${value.registered_office}` : ""]
            .filter(Boolean)
            .join(" · ")}
        </p>
      ) : null}
    </div>
  );
}

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
    entity_id: "",
  };
}

export function PartyFields({ value, onChange, records = [], disabled = false, showCompanyNumber = false }) {
  function update(partial) {
    onChange((current) => ({ ...current, ...partial, id: "" }));
  }

  function pick(id) {
    if (!id) {
      onChange(emptyParty());
      return;
    }
    const found = records.find((row) => row.id === id);
    if (found) onChange({ ...found });
  }

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
        {showCompanyNumber ? (
          <label>
            Company number
            <input
              value={value.company_number || ""}
              onChange={(e) => update({ company_number: e.target.value })}
              placeholder="12345678"
              disabled={disabled || Boolean(value.id)}
            />
          </label>
        ) : null}
        <label>
          Company name
          <input
            value={value.company_name}
            onChange={(e) => update({ company_name: e.target.value })}
            placeholder="Registered company name"
            required
            disabled={disabled || Boolean(value.id)}
          />
        </label>
        <label>
          Signatory
          <input
            value={value.signer_name}
            onChange={(e) => update({ signer_name: e.target.value })}
            placeholder="Person who will sign"
            required
            disabled={disabled || Boolean(value.id)}
          />
        </label>
        <label>
          Role in the company
          <select
            value={value.signer_role}
            onChange={(e) => update({ signer_role: e.target.value })}
            required
            disabled={disabled || Boolean(value.id)}
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
            disabled={disabled || Boolean(value.id)}
          />
        </label>
      </div>
    </div>
  );
}

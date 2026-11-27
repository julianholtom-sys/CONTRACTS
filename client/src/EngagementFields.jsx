export const PAYMENT_MODELS = [
  { key: "paye", label: "PAYE only" },
  { key: "paye_cis", label: "PAYE and CIS" },
];

/** The contractor fee and payment models a broker's Word contract prints. */
export function EngagementFields({ needs = [], value, onChange, disabled = false }) {
  return (
    <div className="form-grid">
      {needs.includes("contractor_fee") ? (
        <label>
          Contractor fee (£ per worker per pay period, excluding VAT)
          <input
            inputMode="decimal"
            value={value.contractorFee}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, contractorFee: e.target.value })}
            placeholder="12.50"
            required
          />
        </label>
      ) : null}
      {needs.includes("payment_models") ? (
        <div>
          Payment models
          {PAYMENT_MODELS.map((model) => (
            <label key={model.key} className="consent">
              <input
                type="radio"
                name="payment-models"
                checked={value.paymentModels === model.key}
                disabled={disabled}
                onChange={() => onChange({ ...value, paymentModels: model.key })}
                required
              />
              <span>{model.label}</span>
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}

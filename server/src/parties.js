/** Sign order: Contractor, Supplier (4-way only), Broker, Client. */
export const SIGN_ORDER = ["supplier", "spv", "agency", "company"];

export const PARTY_LABELS = {
  company: "Client",
  agency: "Broker",
  supplier: "Contractor",
  spv: "Supplier (SPV)",
};

/** The only party who signs by link. The others sign with the signature saved on their record. */
export const SIGNS_BY_LINK = "company";

/**
 * Documents bound into the completed contract. Anything already collected for the
 * due diligence pack is left out. The client uploads its own when it signs; the
 * contractor's and supplier's director ID comes from their record (SIGNING_UPLOADS).
 */
export const FINAL_EVIDENCE = {
  company: [
    ["incorporation_cert", "Certificate of incorporation"],
    ["vat_certificate", "VAT certificate"],
    ["director_id", "Proof of Director ID (passport or driving license)"],
  ],
  supplier: [
    ["director_id", "Proof of Director ID (passport or driving license)"],
  ],
  spv: [["director_id", "Proof of Director ID (passport or driving license)"]],
  agency: [],
};

/**
 * Documents requested before the due diligence pack is compiled.
 * Drawn from the Union Payroll contractor pack (incorporation, VAT, PSC,
 * insurance, bank evidence, payslip; supplier incorporation, PAYE letter).
 * Name-change certificates are added per declared change, not listed here.
 */
export const DD_REQUIREMENTS = {
  supplier: [
    ["incorporation", "Certificate of incorporation"],
    ["vat", "VAT registration certificate"],
    ["psc", "Person with significant control notice (PSC01)"],
    [
      "insurance",
      "Insurance certificates (employers' liability, public liability and professional indemnity)",
    ],
    ["bank", "Bank account evidence in the contractor's own name"],
    ["payslip", "Sample payslip"],
  ],
  spv: [
    ["incorporation", "Certificate of incorporation"],
    ["paye_letter", "HMRC PAYE reference letter"],
  ],
};

export const OFFICE_CHANGE_ITEM = [
  "registered_office",
  "Change of registered office (AD01)",
];

/** Insurance details entered on each company record, with the certificate that evidences each policy. */
export const INSURANCE_POLICIES = {
  contractor: [
    ["el", "Employers’ Liability", "el_certificate"],
    ["pl", "Public Liability", "pl_certificate"],
    ["pi", "Professional Indemnity", "pi_certificate"],
  ],
};

/** Employers’ Liability cover below this is flagged in the pack. */
export const EL_MINIMUM_COVER = 5000000;

/**
 * Files a person attaches when the contractor or supplier is added.
 * Companies House filings and the UK sanctions check are fetched from the
 * company number and are not asked for here.
 */
export const PARTY_UPLOADS = {
  contractor: [
    ["vat", "VAT registration certificate"],
    ["el_certificate", "Employers’ Liability certificate"],
    ["pl_certificate", "Public Liability certificate"],
    ["pi_certificate", "Professional Indemnity certificate"],
    ["pi_schedule", "Professional Indemnity policy schedule and wording"],
    ["bank", "Bank statement for the account paying workers and HMRC"],
    ["payslip", "Illustrative payslip"],
    ["payroll_chain", "Payroll chain map and PAYE/ERN confirmation"],
  ],
  supplier: [["paye_letter", "HMRC PAYE registration letter"]],
};

/**
 * The Supplier has no insurance of its own: it is added to the contractor’s
 * Employers’ Liability policy, so on a 4-way the contractor supplies the evidence.
 */
export const FOUR_WAY_UPLOADS = {
  contractor: [
    ["el_supplier_certificate", "Employers’ Liability certificate naming the Supplier"],
    ["el_supplier_pages", "Employers’ Liability policy pages adding the Supplier"],
  ],
};

/** Kept on the contractor or supplier record for signing; not part of the due diligence pack. */
export const SIGNING_UPLOADS = {
  contractor: [["director_id", "Proof of Director ID (passport or driving license)"]],
  supplier: [["director_id", "Proof of Director ID (passport or driving license)"]],
};

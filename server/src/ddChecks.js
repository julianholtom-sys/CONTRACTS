import { db } from "./db.js";
import { EL_MINIMUM_COVER } from "./parties.js";
import { registryBundle } from "./partyRecords.js";
import { normalCase } from "./packLayout.js";
import { ukDate } from "./coverStamp.js";

const DAY_MS = 86400000;

export function localDay(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** 31/01 plus one month is the last day of February, not 3 March. */
export function addMonths(day, months) {
  const [year, month, date] = day.split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(date, last));
  return target.toISOString().slice(0, 10);
}

const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

export const REVIEW_FREQUENCIES = {
  monthly: { label: "Monthly", months: 1 },
  quarterly: { label: "Quarterly", months: 3 },
};

export function reviewFrequency(envelope) {
  return REVIEW_FREQUENCIES[envelope?.dd_review_frequency] ? envelope.dd_review_frequency : "monthly";
}

export function nextReview(envelope, packDay) {
  return addMonths(packDay, REVIEW_FREQUENCIES[reviewFrequency(envelope)].months);
}

const TITLE = /^(mr|mrs|ms|miss|mx|dr|sir|prof)\.?\s+/i;
const CORPORATE = /\b(limited|ltd|llp|plc|lp|inc|llc|corporation|company|trust|partnership)\.?$/i;

/** Companies House lists officers as "SURNAME, Forenames". */
function officerName(name) {
  const [surname, rest] = String(name || "").split(",").map((part) => part.trim());
  if (!rest) return String(name || "").trim();
  return `${rest} ${surname.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (_, lead, letter) => lead + letter.toUpperCase())}`;
}

const personKey = (name) =>
  String(name || "")
    .replace(TITLE, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** Current directors and individual PSCs, one entry per person, with their Companies House identity verification. */
export function screenedPeople(bundle) {
  const people = new Map();
  const add = (name, role, source) => {
    const key = personKey(name);
    if (!key) return;
    const entry = people.get(key) || { key, name, roles: [], statuses: [], dueOn: "" };
    if (!entry.roles.includes(role)) entry.roles.push(role);
    entry.statuses.push(source.identityVerified);
    entry.dueOn = entry.dueOn || source.verificationDueOn || "";
    people.set(key, entry);
  };
  for (const officer of bundle?.officers || []) {
    if (officer.resignedOn || !/director/i.test(officer.role || "")) continue;
    add(officerName(officer.name), "director", officer);
  }
  for (const person of bundle?.pscs || []) {
    const name = String(person.name || "").replace(TITLE, "").trim();
    if (person.ceasedOn || person.registrationNumber || CORPORATE.test(name)) continue;
    add(name, "PSC", person);
  }
  return [...people.values()].map(({ statuses, ...entry }) => ({
    ...entry,
    verified: statuses.some((status) => status === undefined) ? null : statuses.every(Boolean),
  }));
}

export const rolesText = (roles) => roles.join(" and ");

/** Every director and PSC on the pack, with the staff PEP and adverse media decision saved for this contract. */
export function pepRows(envelopeId, records) {
  const saved = new Map(
    db
      .prepare("SELECT * FROM envelope_pep_checks WHERE envelope_id = ?")
      .all(envelopeId)
      .map((row) => [`${row.role_key}|${row.person_key}`, row])
  );
  return records.flatMap((record) =>
    screenedPeople(record.directoryId ? registryBundle(record.directoryId) : null).map((person) => {
      const row = saved.get(`${record.roleKey}|${person.key}`);
      return {
        roleKey: record.roleKey,
        label: record.label,
        companyName: record.companyName,
        personKey: person.key,
        name: person.name,
        roles: person.roles,
        verified: person.verified,
        verificationDueOn: person.dueOn,
        result: row?.result || "clear",
        approvedBy: row?.approved_by || "",
        approvedOn: row?.approved_on || "",
      };
    })
  );
}

const pounds = (amount) => `£${Number(amount).toLocaleString("en-GB")}`;

/** One check row per policy, flagged on low Employers’ Liability cover or an expiry within 30 days of the pack date. */
export function insuranceChecks(record, packDay) {
  return (record.insurance || []).map((policy) => {
    const reasons = [];
    if (policy.key === "el" && policy.cover != null && policy.cover < EL_MINIMUM_COVER) {
      reasons.push(`cover under ${pounds(EL_MINIMUM_COVER)}`);
    }
    if (policy.expiresOn) {
      const days = daysBetween(packDay, policy.expiresOn);
      if (days < 0) reasons.push("expired");
      else if (policy.key === "el" && days <= 30) reasons.push("expires within 30 days");
    }
    const complete = policy.insurer && policy.policyNumber && policy.cover != null && policy.expiresOn;
    const details = complete
      ? `${policy.insurer}, policy ${policy.policyNumber}, cover ${pounds(policy.cover)}, expires ${ukDate(policy.expiresOn)}`
      : "details not entered";
    return {
      key: policy.key,
      certificate: policy.certificate,
      result: complete && !reasons.length ? "clear" : "flag",
      text: `${policy.label} insurance: ${details}${reasons.length ? ` (${reasons.join(", ")})` : ""}`,
    };
  });
}

/** The names the pack's prose uses, in normal case, for this contract's chain. */
export function chainNames(envelope, sources, entity) {
  const four = envelope?.party_shape === "four";
  const contractor = sources.records.find((record) => record.roleKey === "supplier");
  const supplier = sources.records.find((record) => record.roleKey === "spv");
  const prose = (record, fallback) => (record ? record.normalName || normalCase(record.companyName) : fallback);
  const client = sources.byRole.company?.company_name;
  return {
    four,
    broker: entity?.display_name || "the broker",
    client: client ? normalCase(client) : "the Client",
    contractor: prose(contractor, "the Contractor"),
    supplier: four ? prose(supplier, "the Supplier (SPV)") : "",
    employer: four ? prose(supplier, "the Supplier (SPV)") : prose(contractor, "the Contractor"),
    employerRecord: four ? supplier : contractor,
  };
}

export const WORKER_TYPES = {
  regular: "Regular hours",
  irregular: "Irregular hours",
  part_year: "Part-year",
};

export const HOLIDAY_METHODS = {
  taken: "Paid when taken",
  rolled_up: "Rolled up at 12.07%",
};

export const WORKER_TOPICS = [
  ["pay", "Pay calculation"],
  ["pension", "Pension"],
  ["right_to_work", "Right to Work"],
  ["ir35", "IR35"],
  ["kid", "Key Information Document"],
  ["holiday", "Holiday pay"],
];

/** Rolled-up holiday pay is unlawful for regular-hours workers, so it falls back to paid when taken. */
export function workerSettings(envelope) {
  let saved = {};
  try {
    saved = JSON.parse(envelope?.dd_worker_json || "{}") || {};
  } catch {
    saved = {};
  }
  const workerType = WORKER_TYPES[saved.workerType] ? saved.workerType : "regular";
  const holidayMethod = workerType !== "regular" && saved.holidayMethod === "rolled_up" ? "rolled_up" : "taken";
  return { workerType, holidayMethod, confirmed: saved.confirmed || {} };
}

export function holidayText({ workerType, holidayMethod }) {
  if (holidayMethod !== "rolled_up") return "Workers accrue paid holiday and are paid for it when they take leave.";
  const kind = workerType === "part_year" ? "part-year" : "irregular-hours";
  return `Workers are ${kind} workers and receive rolled-up holiday pay at 12.07%, shown as a separate line on each payslip.`;
}

export function workerArrangements(envelope, names) {
  const settings = workerSettings(envelope);
  const { employer, client, broker } = names;
  const text = {
    pay: `Workers’ pay is calculated by ${employer} using Finity payroll software and checked by ${broker} before each pay run.`,
    pension: `${employer} automatically enrols eligible workers into a Smart Pension workplace pension scheme and pays employer contributions at no less than the legal minimum.`,
    right_to_work: `Right to Work checks are carried out by ${client} on behalf of ${employer} before each worker starts. ${employer} keeps a copy of each check.`,
    ir35: `Workers employed by ${employer} are paid through PAYE, so the off-payroll working (IR35) rules do not apply to them. If any worker provides services through their own limited company, the end client issues a Status Determination Statement.`,
    kid: "Every worker receives a Key Information Document before starting work.",
    holiday: holidayText(settings),
  };
  return WORKER_TOPICS.map(([key, label]) => ({
    key,
    label,
    text: text[key],
    confirmed: Boolean(settings.confirmed[key]),
    confirmedBy: settings.confirmed[key]?.by || "",
    confirmedOn: settings.confirmed[key]?.on || "",
  }));
}

/** What still stops the broker signing: unapproved PEP rows and unconfirmed worker arrangements. */
export function signBlockers(pep, worker) {
  return [
    ...pep
      .filter((row) => !row.approvedOn)
      .map((row) => `PEP and adverse media screening awaiting approval: ${row.name}, ${row.companyName}`),
    ...worker.filter((row) => !row.confirmed).map((row) => `Worker arrangements not confirmed: ${row.label}`),
  ];
}

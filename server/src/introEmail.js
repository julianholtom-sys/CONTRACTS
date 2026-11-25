export function timeOfDay(date = new Date()) {
  return date.getHours() < 12 ? "morning" : "afternoon";
}

export function applyIntroTimeOfDay(text, date = new Date()) {
  const period = timeOfDay(date);
  let out = String(text || "").replace(/\{\{\s*time_of_day\s*\}\}/gi, period);
  const nl = out.indexOf("\n");
  const first = nl === -1 ? out : out.slice(0, nl);
  const rest = nl === -1 ? "" : out.slice(nl);
  let line = first;
  if (/^Good\s+(morning|afternoon|evening)\b/i.test(line)) {
    line = line.replace(/^Good\s+(morning|afternoon|evening)\b/i, `Good ${period}`);
  } else if (/^Good\s*,/i.test(line)) {
    line = line.replace(/^Good\s*,/i, `Good ${period},`);
  } else if (/^Good\s*$/i.test(line)) {
    line = `Good ${period}`;
  }
  return line + rest;
}

export function otherParties(partyShape) {
  return partyShape === "four"
    ? "the Contractor, the Supplier and the Client"
    : "the Contractor and the Client";
}

export function introForBroker(text, brokerName, { complianceName = "", partyShape = "three", date = new Date() } = {}) {
  const broker = String(brokerName || "").trim();
  const named = applyIntroTimeOfDay(text, date)
    .replace(/\{\{\s*broker_name\s*\}\}/gi, () => broker)
    .replace(/\{\{\s*compliance_name\s*\}\}/gi, () => String(complianceName || "").trim())
    .replace(/\{\{\s*other_parties\s*\}\}/gi, () => otherParties(partyShape));
  if (!broker || named.toLowerCase().includes(broker.toLowerCase())) return named.trim();
  const line = `This contract is sent on behalf of ${broker}.`;
  return [named.trim(), line].filter(Boolean).join("\n\n");
}

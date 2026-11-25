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

export function introForBroker(text, brokerName, date = new Date()) {
  const broker = String(brokerName || "").trim();
  const named = applyIntroTimeOfDay(text, date).replaceAll("{{broker_name}}", broker);
  if (!broker || named.toLowerCase().includes(broker.toLowerCase())) return named.trim();
  const line = `This contract is sent on behalf of ${broker}.`;
  return [named.trim(), line].filter(Boolean).join("\n\n");
}

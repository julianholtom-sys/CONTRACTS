import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./db.js";

const LIST_URL = "https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.csv";
const CACHE = path.join(DATA_DIR, "sanctions", "UK-Sanctions-List.csv");
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

const STOP = new Set([
  "limited",
  "ltd",
  "plc",
  "llp",
  "the",
  "and",
  "of",
  "company",
  "co",
  "uk",
]);

function tokens(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .split(/[^a-z0-9]+/)
    .filter((word) => word && !STOP.has(word));
}

async function ensureList() {
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  const fresh =
    fs.existsSync(CACHE) && Date.now() - fs.statSync(CACHE).mtimeMs < MAX_AGE_MS;
  if (fresh) return CACHE;
  const response = await fetch(LIST_URL, {
    headers: { "User-Agent": "ContractBuilder/1.0 (sanctions screening)" },
  });
  if (!response.ok) throw new Error(`UK Sanctions List returned ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const temp = `${CACHE}.part`;
  fs.writeFileSync(temp, bytes);
  fs.renameSync(temp, CACHE);
  return CACHE;
}

function splitCsv(line) {
  const cells = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else quoted = false;
      } else current += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      cells.push(current);
      current = "";
    } else current += char;
  }
  cells.push(current);
  return cells;
}

function reportDate(firstLine) {
  const match = String(firstLine || "").match(/Report Date:\s*(.+)/i);
  return match ? match[1].trim() : "";
}

export async function screenNames({ companyName, previousNames = [], companyNumber, people = [] }) {
  const file = await ensureList();
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  const listedOn = reportDate(lines[0]);
  const headerIndex = lines.findIndex((line) => line.startsWith("Last Updated,"));
  if (headerIndex < 0) throw new Error("UK Sanctions List was not in the expected format");
  const header = splitCsv(lines[headerIndex]);
  const nameIndexes = header
    .map((name, index) => ({ name, index }))
    .filter((item) => /^Name [1-6]$/.test(item.name) || item.name === "Name non-latin script")
    .map((item) => item.index);
  const registrationIndex = header.indexOf("Business registration number (s)");
  const uniqueIndex = header.indexOf("Unique ID");
  const regimeIndex = header.indexOf("Regime Name");

  const companyTokens = tokens(companyName);
  const formerNames = previousNames
    .map((name) => ({ name, words: tokens(name) }))
    .filter((item) => item.words.length);
  const number = String(companyNumber || "").replace(/\s+/g, "").toUpperCase();
  const bareNumber = number.replace(/^0+/, "");
  const seenPeople = new Set();
  const personTargets = people
    .map((person) => {
      const raw = String(person.name || "");
      const [surname, rest] = raw.split(",").map((part) => part.trim());
      const words = tokens(rest ? `${rest} ${surname}` : raw);
      return { name: rest ? `${rest} ${surname}` : raw, words };
    })
    .filter((person) => {
      const key = [...person.words].sort().join(" ");
      if (person.words.length < 2 || seenPeople.has(key)) return false;
      seenPeople.add(key);
      return true;
    });

  const byId = new Map();
  for (const line of lines.slice(headerIndex + 1)) {
    if (!line.trim()) continue;
    const cells = splitCsv(line);
    const words = new Set(tokens(nameIndexes.map((index) => cells[index] || "").join(" ")));
    const registrations = String(cells[registrationIndex] || "")
      .toUpperCase()
      .split(/[^A-Z0-9]+/)
      .map((part) => part.replace(/^0+/, ""));
    const reasons = [];
    if (bareNumber && registrations.includes(bareNumber)) reasons.push("company number");
    if (companyTokens.length && companyTokens.every((word) => words.has(word))) {
      reasons.push("company name");
    }
    for (const former of formerNames) {
      if (former.words.every((word) => words.has(word))) reasons.push(`previous name ${former.name}`);
    }
    for (const person of personTargets) {
      if (person.words.every((word) => words.has(word))) {
        reasons.push(person.name);
      }
    }
    if (!reasons.length) continue;
    const uniqueId = cells[uniqueIndex] || `row-${byId.size}`;
    const existing = byId.get(uniqueId);
    if (existing) {
      for (const reason of reasons) {
        if (!existing.matchedOn.includes(reason)) existing.matchedOn.push(reason);
      }
      continue;
    }
    if (byId.size >= 20) continue;
    byId.set(uniqueId, {
      uniqueId,
      regime: cells[regimeIndex] || "",
      name: nameIndexes
        .map((index) => cells[index] || "")
        .filter(Boolean)
        .join(" "),
      matchedOn: reasons,
    });
  }
  const hits = [...byId.values()];

  return {
    listedOn,
    searchedAt: new Date().toISOString(),
    sourceUrl: "https://search-uk-sanctions-list.service.gov.uk/",
    listUrl: LIST_URL,
    query: {
      companyName,
      previousNames: formerNames.map((item) => item.name),
      companyNumber: number,
      people: personTargets.map((person) => person.name),
    },
    hitCount: hits.length,
    hits,
  };
}

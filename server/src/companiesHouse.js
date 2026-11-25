const CH = "https://find-and-update.company-information.service.gov.uk";

const FILING_KEYS = {
  NEWINC: "incorporation",
  CERTINC: "incorporation",
  CERTNM: "change_of_name",
  NM01: "change_of_name",
  AD01: "registered_office",
  PSC01: "psc",
  PSC02: "psc",
};

const EVIDENCE_ORDER = ["incorporation", "change_of_name", "registered_office", "psc"];

const FILING_LABELS = {
  incorporation: "Certificate of incorporation",
  change_of_name: "Change of name",
  registered_office: "Registered office change (AD01)",
  psc: "Person with significant control notice",
};

const TYPE_LABELS = {
  CERTNM: "Change of name certificate",
  NM01: "Change of name by resolution (NM01)",
  PSC01: "PSC notice (PSC01)",
  PSC02: "Corporate PSC notice (PSC02)",
};

export function filingLabel(key, type) {
  return TYPE_LABELS[type] || FILING_LABELS[key] || key;
}

export function normaliseCompanyNumber(value) {
  const raw = String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (!raw) throw new Error("A company number is required");
  if (!/^[A-Z]{0,2}\d{6,8}$/.test(raw) && !/^\d{6,8}$/.test(raw)) {
    throw new Error("Company number should look like 12345678");
  }
  if (/^\d+$/.test(raw)) return raw.padStart(8, "0");
  return raw;
}

function decode(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function field(html, id) {
  const match = html.match(new RegExp(`id="${id}"[^>]*>([\\s\\S]*?)</`, "i"));
  return match ? decode(match[1]) : "";
}

async function getText(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "ContractBuilder/1.0 (due diligence pack; company records)",
      Accept: "text/html",
    },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`Companies House returned ${response.status} for ${url}`);
  }
  return response.text();
}

function parseProfile(html) {
  const name = decode((html.match(/<h1 class="heading-xlarge"[^>]*>([\s\S]*?)<\/h1>/i) || [])[1]);
  const accounts = decode(
    (html.match(/<h2 class="heading-medium"><strong>Accounts<\/strong><\/h2>([\s\S]*?)<\/div>/i) || [])[1]
  );
  const confirmation = decode(
    (html.match(/<h2 class="heading-medium"><strong>Confirmation statement<\/strong><\/h2>([\s\S]*?)<\/div>/i) ||
      [])[1]
  );
  const previousNames = [];
  for (let n = 1; field(html, `previous-name-${n}`); n += 1) {
    previousNames.push({ name: field(html, `previous-name-${n}`), period: field(html, `previous-date-${n}`) });
  }
  return {
    legalName: name,
    previousNames,
    companyNumber: field(html, "company-number").replace(/^Company number\s*/i, ""),
    status: field(html, "company-status"),
    companyType: field(html, "company-type-value"),
    incorporatedOn: field(html, "company-creation-date"),
    registeredOffice: field(html, "roa-address"),
    accounts,
    confirmationStatement: confirmation,
  };
}

function parsePeople(html, prefix) {
  const people = [];
  const blocks = html.split(new RegExp(`<div class="appointment-\\d+">`, "i")).slice(1);
  blocks.forEach((block, index) => {
    const n = index + 1;
    const name = field(block, `${prefix}-name-${n}`) || field(html, `${prefix}-name-${n}`);
    if (!name) return;
    people.push({
      name,
      status: field(block, `${prefix}-status-tag-${n}`) || field(html, `${prefix}-status-tag-${n}`),
      role: field(block, `${prefix === "officer" ? "officer-role" : "psc-kind"}-${n}`),
      appointedOn: field(block, `officer-appointed-on-${n}`),
      resignedOn: field(block, `officer-resigned-on-${n}`),
      notifiedOn: field(block, `psc-notified-on-${n}`),
      nationality: field(block, `${prefix}-nationality-${n}`),
      country: field(block, `${prefix}-country-of-residence-${n}`),
      dateOfBirth: field(block, `${prefix}-date-of-birth-${n}`),
      natureOfControl: [...block.matchAll(new RegExp(`id="psc-noc-${n}-[^"]*"[^>]*>([\\s\\S]*?)</dd>`, "gi"))]
        .map((match) => decode(match[1]))
        .filter(Boolean)
        .join("; "),
      ceasedOn: field(block, `psc-ceased-on-${n}`),
      registrationNumber: field(block, `psc-registration-number-${n}`),
      address: field(block, `${prefix}-address-value-${n}`),
    });
  });
  return people;
}

function parseFilings(html) {
  const filings = [];
  const rows = html.split("<tr>").slice(1);
  for (const row of rows) {
    const type = decode((row.match(/filing-type[^"]*"[^>]*>\s*([A-Z0-9]+)\s*</i) || [])[1]);
    const key = FILING_KEYS[type];
    if (!key) continue;
    const date = decode((row.match(/<td class="nowrap">\s*([^<]+?)\s*<\/td>/i) || [])[1]);
    const description = decode((row.match(/<td>\s*([\s\S]*?)<\/td>/i) || [])[1]);
    const href = (row.match(/href="([^"]*\/document\?format=pdf[^"]*)"/i) || [])[1];
    if (!href) continue;
    filings.push({
      type,
      filingId: (href.match(/filing-history\/([^/]+)\/document/i) || [])[1] || "",
      key,
      label: filingLabel(key, type),
      date,
      description,
      pdfUrl: href.startsWith("http") ? href.replace(/&amp;/g, "&") : `${CH}${href.replace(/&amp;/g, "&")}`,
    });
  }
  return filings;
}

/**
 * One filing per fact: the incorporation, each change of name, the latest
 * registered office move, and the notice for each current PSC. Filing history
 * is newest first.
 */
function evidenceFilings(filings, pscs) {
  const current = pscs
    .filter((person) => !person.ceasedOn)
    .map((person) => person.name.toLowerCase().replace(/^(mr|mrs|ms|miss|dr|sir)\.?\s+/, ""));
  const certified = new Set(filings.filter((filing) => filing.type === "CERTNM").map((filing) => filing.date));
  const notified = new Set();
  const kept = [];
  for (const filing of filings) {
    if (filing.key === "registered_office") {
      if (!kept.some((item) => item.key === "registered_office")) kept.push(filing);
    } else if (filing.key === "change_of_name") {
      if (filing.type === "CERTNM" || !certified.has(filing.date)) kept.push(filing);
    } else if (filing.key === "psc") {
      const description = filing.description.toLowerCase();
      const person = current.find((name) => description.includes(name));
      if (person && !notified.has(person)) {
        notified.add(person);
        kept.push(filing);
      }
    }
  }
  const incorporation = filings.filter((filing) => filing.key === "incorporation").at(-1);
  if (incorporation) kept.push(incorporation);
  return kept
    .reverse()
    .sort((a, b) => EVIDENCE_ORDER.indexOf(a.key) - EVIDENCE_ORDER.indexOf(b.key));
}

export async function fetchCompanyRecord(companyNumber) {
  const number = normaliseCompanyNumber(companyNumber);
  const profileHtml = await getText(`${CH}/company/${number}`);
  const profile = parseProfile(profileHtml);
  profile.companyNumber = profile.companyNumber || number;
  profile.sourceUrl = `${CH}/company/${number}`;

  const [officerHtml, pscHtml] = await Promise.all([
    getText(`${CH}/company/${number}/officers`),
    getText(`${CH}/company/${number}/persons-with-significant-control`).catch(() => ""),
  ]);
  const officers = parsePeople(officerHtml, "officer");
  const pscs = pscHtml ? parsePeople(pscHtml, "psc") : [];

  const filings = [];
  const seen = new Set();
  for (let page = 1; page <= 8; page += 1) {
    const url =
      page === 1
        ? `${CH}/company/${number}/filing-history`
        : `${CH}/company/${number}/filing-history?page=${page}`;
    const html = await getText(url);
    const found = parseFilings(html);
    if (!found.length) break;
    for (const filing of found) {
      if (seen.has(filing.pdfUrl)) continue;
      seen.add(filing.pdfUrl);
      filings.push(filing);
    }
    if (!html.includes(`page=${page + 1}`)) break;
  }

  return { profile, officers, pscs, filings: evidenceFilings(filings, pscs) };
}

function personName(name) {
  const [surname, rest] = String(name || "").split(",").map((part) => part.trim());
  if (!rest) return name;
  const titled = surname.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (_, lead, letter) => lead + letter.toUpperCase());
  return `${rest} ${titled}`;
}

/** Details only: the client supplies its own certificates when it signs, so no filings are fetched. */
export async function lookupCompany(companyNumber) {
  const number = normaliseCompanyNumber(companyNumber);
  let html;
  try {
    html = await getText(`${CH}/company/${number}`);
  } catch (err) {
    if (/ 404 /.test(err.message)) throw new Error(`Companies House has no company with number ${number}`);
    throw err;
  }
  const profile = parseProfile(html);
  const officerHtml = await getText(`${CH}/company/${number}/officers`).catch(() => "");
  const officers = officerHtml ? parsePeople(officerHtml, "officer") : [];
  return {
    companyNumber: profile.companyNumber || number,
    legalName: profile.legalName,
    status: profile.status,
    registeredOffice: profile.registeredOffice,
    incorporatedOn: profile.incorporatedOn,
    directors: officers
      .filter((officer) => !officer.resignedOn && /director/i.test(officer.role || ""))
      .map((officer) => ({ name: personName(officer.name), role: officer.role, appointedOn: officer.appointedOn })),
  };
}

export async function downloadFiling(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "ContractBuilder/1.0 (due diligence pack; company records)",
      Accept: "application/pdf,*/*",
    },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`Companies House document returned ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.slice(0, 5).toString() !== "%PDF-") {
    throw new Error("Companies House did not return a PDF for that filing");
  }
  return bytes;
}

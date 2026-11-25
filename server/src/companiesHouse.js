const CH = "https://find-and-update.company-information.service.gov.uk";

const FILING_KEYS = {
  NEWINC: "incorporation",
  CERTINC: "incorporation",
  CERTNM: "change_of_name",
  NM01: "change_of_name",
  AD01: "registered_office",
  PSC01: "psc",
  PSC02: "psc",
  PSC04: "psc",
  PSC05: "psc",
  PSC07: "psc",
};

const FILING_LABELS = {
  incorporation: "Certificate of incorporation",
  change_of_name: "Change of name",
  registered_office: "Registered office change (AD01)",
  psc: "Person with significant control notice",
};

export function filingLabel(key) {
  return FILING_LABELS[key] || key;
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
  return {
    legalName: name,
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
      natureOfControl: field(block, `psc-nature-of-control-${n}`),
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
      key,
      label: filingLabel(key),
      date,
      description,
      pdfUrl: href.startsWith("http") ? href.replace(/&amp;/g, "&") : `${CH}${href.replace(/&amp;/g, "&")}`,
    });
  }
  return filings;
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

  return { profile, officers, pscs, filings };
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

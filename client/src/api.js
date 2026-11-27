const base = "";

async function request(path, options = {}) {
  const res = await fetch(`${base}${path}`, { credentials: "include", ...options });
  if (res.status === 401 && !path.startsWith("/api/auth/")) {
    window.dispatchEvent(new Event("attest-signed-out"));
  }
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }
  if (res.status === 204) return null;
  return res.json();
}

export const api = {
  health: () => request("/api/health"),
  me: () => request("/api/auth/me"),
  login: (email, password) =>
    request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    }),
  logout: () => request("/api/auth/logout", { method: "POST" }),
  library: () => request("/api/library"),
  saveLibrary: (body) =>
    request("/api/library", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  compliance: () => request("/api/compliance"),
  saveCompliance: (body) =>
    request("/api/compliance", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  testComplianceMail: (body) =>
    request("/api/compliance/mail/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  directory: (kind) =>
    request(`/api/directory${kind ? `?kind=${encodeURIComponent(kind)}` : ""}`),
  parties: (kind) => request(`/api/parties?kind=${encodeURIComponent(kind)}`),
  party: (id) => request(`/api/parties/${id}`),
  saveParty: (kind, body) =>
    request(`/api/parties/${kind}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  updateParty: (id, body) =>
    request(`/api/parties/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  fetchPartyRegistry: (id) => request(`/api/parties/${id}/registry`, { method: "POST" }),
  savePartyDetails: (id, body) =>
    request(`/api/parties/${id}/details`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  companyLookup: (number) => request(`/api/companies-house/${encodeURIComponent(number)}`),
  uploadPartyFile: (id, requirementKey, file) => {
    const body = new FormData();
    body.append("requirementKey", requirementKey);
    body.append("file", file);
    return request(`/api/parties/${id}/files`, { method: "POST", body });
  },
  partyFileUrl: (id, fileId) => `/api/parties/${id}/files/${fileId}`,
  savePartySignature: (id, signature) =>
    request(`/api/parties/${id}/signature`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        signatureDataUrl: signature.dataUrl,
        method: signature.method,
        typedName: signature.text || "",
      }),
    }),
  saveDueDiligenceChecks: (id, checks) =>
    request(`/api/envelopes/${id}/dd/checks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ checks }),
    }),
  saveDiligenceSettings: (id, body) =>
    request(`/api/envelopes/${id}/dd/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  savePepCheck: (id, body) =>
    request(`/api/envelopes/${id}/dd/pep`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  confirmWorkerArrangement: (id, body) =>
    request(`/api/envelopes/${id}/dd/worker`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  saveBrokerSignatory: (entityId, body) =>
    request(`/api/entities/${entityId}/signatory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  bootstrap: () => request("/api/bootstrap"),
  listEntities: () => request("/api/entities"),
  getEntity: (id) => request(`/api/entities/${id}`),
  createEntity: (body) =>
    request("/api/entities", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  updateEntity: (id, body) =>
    request(`/api/entities/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  deleteEntity: (id) => request(`/api/entities/${id}`, { method: "DELETE" }),
  deleteEntityAsset: (entityId, assetId) =>
    request(`/api/entities/${entityId}/assets/${assetId}`, { method: "DELETE" }),
  ingestImage: (url) =>
    request("/api/ingest-image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    }),
  uploadEntityAsset: (id, kind, file, name) => {
    const body = new FormData();
    body.append("kind", kind);
    if (name) body.append("name", name);
    body.append("file", file);
    return request(`/api/entities/${id}/assets`, { method: "POST", body });
  },
  listTemplates: () => request("/api/templates"),
  getTemplate: (id) => request(`/api/templates/${id}`),
  getMasterTemplate: () => request("/api/templates/master"),
  updateMasterTemplate: (body) =>
    request("/api/templates/master", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  uploadMasterTemplate: (file, { name, description } = {}) => {
    const body = new FormData();
    if (name) body.append("name", name);
    if (description) body.append("description", description);
    body.append("file", file);
    return request("/api/templates/master/file", { method: "POST", body });
  },
  brokerContracts: (entityId) => request(`/api/brokers/${entityId}/contracts`),
  uploadBrokerContract: (entityId, type, file, { name } = {}) => {
    const body = new FormData();
    if (name) body.append("name", name);
    body.append("file", file);
    return request(`/api/brokers/${entityId}/contracts/${type}/file`, { method: "POST", body });
  },
  updateBrokerContract: (entityId, type, body) =>
    request(`/api/brokers/${entityId}/contracts/${type}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  deleteBrokerContract: (entityId, type) =>
    request(`/api/brokers/${entityId}/contracts/${type}`, { method: "DELETE" }),
  brokerContractFileUrl: (entityId, type) => `/api/brokers/${entityId}/contracts/${type}/file`,
  uploadBrokerPack: (entityId, type, file) => {
    const body = new FormData();
    body.append("file", file);
    return request(`/api/brokers/${entityId}/packs/${type}/file`, { method: "POST", body });
  },
  deleteBrokerPack: (entityId, type) => request(`/api/brokers/${entityId}/packs/${type}`, { method: "DELETE" }),
  brokerPackFileUrl: (entityId, type) => `/api/brokers/${entityId}/packs/${type}/file`,
  saveWordPack: (id, body) =>
    request(`/api/envelopes/${id}/pack`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  uploadWordPackFile: (id, key, file) => {
    const body = new FormData();
    body.append("key", key);
    body.append("file", file);
    return request(`/api/envelopes/${id}/pack/files`, { method: "POST", body });
  },
  deleteWordPackFile: (id, fileId) => request(`/api/envelopes/${id}/pack/files/${fileId}`, { method: "DELETE" }),
  wordPackFileUrl: (id, fileId) => `/api/envelopes/${id}/pack/files/${fileId}`,
  addSchedule: (entityId, { name, types, file }) => {
    const body = new FormData();
    body.append("name", name);
    body.append("types", types.join(","));
    body.append("file", file);
    return request(`/api/brokers/${entityId}/schedules`, { method: "POST", body });
  },
  updateAppendix: (id, body) =>
    request(`/api/appendices/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  uploadAppendixFile: (id, file) => {
    const body = new FormData();
    body.append("file", file);
    return request(`/api/appendices/${id}/file`, { method: "POST", body });
  },
  deleteAppendix: (id) => request(`/api/appendices/${id}`, { method: "DELETE" }),
  deleteMasterTemplate: () => request("/api/templates/master", { method: "DELETE" }),
  masterFileUrl: () => "/api/templates/master/file",
  appendixFileUrl: (id) => `/api/appendices/${id}/file`,
  verifyDomainDns: (id) =>
    request(`/api/entities/${id}/verify/dns`, { method: "POST" }),
  sendDomainVerifyEmail: (id) =>
    request(`/api/entities/${id}/verify/email`, { method: "POST" }),
  confirmDomainVerifyCode: (id, code) =>
    request(`/api/entities/${id}/verify/code`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    }),
  testCompanyMail: (id, body = {}) =>
    request(`/api/entities/${id}/mail/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  sendCompanyMailTest: (id, body = {}) =>
    request(`/api/entities/${id}/mail/test-send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  disconnectCompanyMail: (id) =>
    request(`/api/entities/${id}/mail/disconnect`, { method: "POST" }),
  listEnvelopes: () => request("/api/envelopes"),
  getEnvelope: (id) => request(`/api/envelopes/${id}`),
  createEnvelope: (body) =>
    request("/api/envelopes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  brandPack: (entityId, { industry, appendixIds = [] } = {}) => {
    const params = new URLSearchParams({ entityId });
    if (industry) params.set("industry", industry);
    if (appendixIds.length) params.set("appendixIds", appendixIds.join(","));
    return request(`/api/brand-pack?${params}`);
  },
  bakeEnvelope: (id) => request(`/api/envelopes/${id}/bake`, { method: "POST" }),
  saveEngagement: (id, body) =>
    request(`/api/envelopes/${id}/engagement`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  sendEnvelope: (id, signingDates) =>
    request(`/api/envelopes/${id}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signingDates }),
    }),
  voidEnvelope: (id, reason) =>
    request(`/api/envelopes/${id}/void`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    }),
  partyLink: (envelopeId, partyId) =>
    request(`/api/envelopes/${envelopeId}/parties/${partyId}/link`, {
      method: "POST",
    }),
  signSession: (token) => request(`/api/sign/${token}`),
  saveField: (token, fieldId, value) =>
    request(`/api/sign/${token}/fields`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fieldId, value }),
    }),
  uploadEvidence: (token, requirementId, file) => {
    const body = new FormData();
    body.append("requirementId", requirementId);
    body.append("file", file);
    return request(`/api/sign/${token}/evidence`, { method: "POST", body });
  },
  sign: (token, payload) =>
    request(`/api/sign/${token}/sign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  decline: (token, reason) =>
    request(`/api/sign/${token}/decline`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    }),
  uploadDueDiligence: (id, { roleKey, requirementKey, nameChangeId, file }) => {
    const body = new FormData();
    body.append("roleKey", roleKey);
    body.append("requirementKey", requirementKey || "");
    if (nameChangeId) body.append("nameChangeId", nameChangeId);
    body.append("file", file);
    return request(`/api/envelopes/${id}/dd/files`, { method: "POST", body });
  },
  addNameChange: (id, body) =>
    request(`/api/envelopes/${id}/dd/name-changes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  removeNameChange: (id, changeId) =>
    request(`/api/envelopes/${id}/dd/name-changes/${changeId}`, { method: "DELETE" }),
  setOfficeChanged: (id, enabled) =>
    request(`/api/envelopes/${id}/dd/office-changed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    }),
  dueDiligenceSignLink: (id) =>
    request(`/api/envelopes/${id}/dd/sign-link`, { method: "POST" }),
  compileDueDiligence: (id) =>
    request(`/api/envelopes/${id}/dd/compile`, { method: "POST" }),
  dueDiligenceUrl: (id) => `/api/envelopes/${id}/due-diligence`,
  diligenceSession: (token) => request(`/api/diligence/${token}`),
  uploadPartyDiligence: (token, { requirementKey, nameChangeId, file }) => {
    const body = new FormData();
    body.append("requirementKey", requirementKey || "");
    if (nameChangeId) body.append("nameChangeId", nameChangeId);
    body.append("file", file);
    return request(`/api/diligence/${token}/files`, { method: "POST", body });
  },
  addPartyNameChange: (token, body) =>
    request(`/api/diligence/${token}/name-changes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  removePartyNameChange: (token, changeId) =>
    request(`/api/diligence/${token}/name-changes/${changeId}`, { method: "DELETE" }),
  setPartyOfficeChanged: (token, enabled) =>
    request(`/api/diligence/${token}/office-changed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    }),
  submitDiligence: (token) =>
    request(`/api/diligence/${token}/submit`, { method: "POST" }),
  signDiligence: (token, payload) =>
    request(`/api/diligence/${token}/sign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  diligencePackUrl: (token) => `/api/diligence/${token}/pack`,
  documentUrl: (id, kind) => `/api/envelopes/${id}/documents/${kind}`,
  entityAssetUrl: (entityId, assetId) => `/api/entities/${entityId}/assets/${assetId}/file`,
};

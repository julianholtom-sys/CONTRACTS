import { useEffect, useState } from "react";
import { api } from "../api.js";
import GmailSignatureEditor from "../GmailSignatureEditor.jsx";
import {
  extractGmailFragment,
  htmlToText,
  inlineSignatureImages,
  isHtmlSignatureFile,
} from "../gmailSignature.js";
import { introForBroker } from "../introEmail.js";

const empty = {
  display_name: "",
  legal_name: "",
  company_number: "",
  registered_office: "",
  from_address: "",
  intro_email_text: "",
  email_signature_html: "",
  email_signature_text: "",
  smtp_host: "smtp.gmail.com",
  smtp_port: 587,
  smtp_user: "",
  smtp_pass: "",
  smtp_provider: "gmail",
  smtp_configured: false,
};

export default function ComplianceCompany({ brokerName = "", embedded = false }) {
  const [form, setForm] = useState(empty);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    api
      .compliance()
      .then((data) => setForm({ ...empty, ...data, smtp_pass: "" }))
      .catch((err) => setError(err.message))
      .finally(() => setReady(true));
  }, []);

  function setField(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  const previewBroker = brokerName || "the broker";
  const [previewShape, setPreviewShape] = useState("three");
  const preview = introForBroker(form.intro_email_text, previewBroker, {
    complianceName: form.display_name,
    partyShape: previewShape,
  });

  async function onSave(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const saved = await api.saveCompliance({ ...form, company_number: "" });
      setForm({ ...empty, ...saved, smtp_pass: "" });
      setNotice("Saved");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function onSignatureFile(file) {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const resolveImages = (url) =>
        api
          .ingestImage(url)
          .then((result) => result.dataUrl)
          .catch(() => "");
      let html = "";
      if (isHtmlSignatureFile(file)) {
        html = await inlineSignatureImages(extractGmailFragment(await file.text()), [], {
          fetchRemote: resolveImages,
        });
      } else if (String(file.type || "").startsWith("image/")) {
        html = await inlineSignatureImages("", [file], { fetchRemote: resolveImages });
      } else {
        throw new Error("Paste the Gmail signature, or choose an HTML export or an image.");
      }
      setForm((current) => ({
        ...current,
        email_signature_html: html,
        email_signature_text: htmlToText(html),
      }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function onTest() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api.testComplianceMail({
        smtp_host: form.smtp_host,
        smtp_port: form.smtp_port,
        smtp_user: form.smtp_user,
        smtp_pass: form.smtp_pass,
        from_address: form.from_address,
      });
      setNotice("Mailbox connection succeeded");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!ready) return <p className="muted">Loading…</p>;

  return (
    <div>
      {embedded ? null : (
        <section className="hero-panel">
          <h1>Compliance company</h1>
          <p>
            Contracts and due diligence packs are sent by this company, on behalf of
            the broker. The introductory email comes from here.
          </p>
        </section>
      )}
      <form className="panel form-grid" onSubmit={onSave}>
        <h2>Company details</h2>
        <label>
          Display name
          <input
            value={form.display_name}
            onChange={(e) => setField("display_name", e.target.value)}
            placeholder="Compliance company"
            required
          />
        </label>
        <label>
          Legal name
          <input
            value={form.legal_name}
            onChange={(e) => setField("legal_name", e.target.value)}
            placeholder="Legal name"
          />
        </label>
        <label>
          Registered office
          <input
            value={form.registered_office}
            onChange={(e) => setField("registered_office", e.target.value)}
            placeholder="Street, city, postcode"
          />
        </label>
        <label>
          From address
          <input
            type="email"
            value={form.from_address}
            onChange={(e) => setField("from_address", e.target.value)}
            placeholder="contracts@compliance.example"
            required
          />
        </label>
        <p className="muted">
          {form.smtp_configured
            ? "A mailbox password is already saved."
            : "Add the mailbox login below so messages send from this address."}
        </p>

        <h2>Introductory email</h2>
        <p className="muted">
          Write {"{{broker_name}}"} where the broker should be named and {"{{compliance_name}}"} for
          this company’s name. {"{{other_parties}}"} reads “the Contractor and the Client” on a 3-way
          contract and “the Contractor, the Supplier and the Client” on a 4-way. The greeting
          becomes Good morning or Good afternoon from this computer’s clock. If the
          broker’s name is missing, a line is added: this contract and due diligence
          pack are sent on behalf of that broker.
        </p>
        <label>
          Intro text
          <textarea
            rows={10}
            value={form.intro_email_text}
            onChange={(e) => setField("intro_email_text", e.target.value)}
            placeholder={
              "Good morning,\n\nWe are sending the contract and due diligence pack on behalf of {{broker_name}}."
            }
          />
        </label>
        <label>
          Preview as
          <select value={previewShape} onChange={(e) => setPreviewShape(e.target.value)}>
            <option value="three">3-way contract</option>
            <option value="four">4-way contract</option>
          </select>
        </label>
        <label>
          How it reads for {previewBroker}
          <textarea rows={8} value={preview} readOnly />
        </label>
        <h2>Gmail signature</h2>
        <p className="muted">
          Paste from Gmail Settings → General → Signature. Formatting, links, and
          images are kept.
        </p>
        <label>
          Signature
          <GmailSignatureEditor
            html={form.email_signature_html}
            resolveImages={(url) =>
              api
                .ingestImage(url)
                .then((result) => result.dataUrl)
                .catch(() => "")
            }
            onChange={({ html, text }) =>
              setForm((current) => ({
                ...current,
                email_signature_html: html,
                email_signature_text: text,
              }))
            }
          />
        </label>
        <label>
          Signature file (optional)
          <input
            type="file"
            accept=".html,.htm,.png,.jpg,.jpeg,.gif,.webp"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              onSignatureFile(file);
            }}
          />
        </label>

        <h2>Mailbox</h2>
        <label>
          SMTP host
          <input
            value={form.smtp_host}
            onChange={(e) => setField("smtp_host", e.target.value)}
            placeholder="smtp.gmail.com"
          />
        </label>
        <label>
          SMTP port
          <input
            value={form.smtp_port}
            onChange={(e) => setField("smtp_port", e.target.value)}
            placeholder="587"
          />
        </label>
        <label>
          Mailbox username
          <input
            value={form.smtp_user}
            onChange={(e) => setField("smtp_user", e.target.value)}
            placeholder="contracts@compliance.example"
          />
        </label>
        <label>
          Mailbox password
          <input
            type="password"
            value={form.smtp_pass}
            onChange={(e) => setField("smtp_pass", e.target.value)}
            placeholder={form.smtp_configured ? "Saved — enter a new one to replace it" : "App password"}
          />
        </label>
        {error ? <p className="error">{error}</p> : null}
        {notice ? <p className="verify-ok">{notice}</p> : null}
        <div className="toolbar">
          <button className="btn" type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save compliance company"}
          </button>
          <button className="btn secondary" type="button" onClick={onTest} disabled={busy}>
            Test mailbox connection
          </button>
        </div>
      </form>
    </div>
  );
}

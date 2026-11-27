import { execFile } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import nodemailer from "nodemailer";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function loadEnvFile(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null || process.env[key] === "") {
      process.env[key] = value;
    }
  }
}

loadEnvFile(path.join(repoRoot, ".env"));
loadEnvFile(path.join(repoRoot, "server", ".env"));

export function smtpConfig(entity = {}) {
  const host = String(entity.smtp_host || process.env.SMTP_HOST || "").trim();
  const user = String(entity.smtp_user || process.env.SMTP_USER || "").trim();
  const pass = String(entity.smtp_pass || process.env.SMTP_PASS || "").trim();
  const port = Number(entity.smtp_port || process.env.SMTP_PORT || 587);
  const from = String(process.env.SMTP_FROM || entity.from_address || user || "").trim();
  if (!host || !user || !pass) return null;
  return { host, port, user, pass, from, secure: port === 465 };
}

function transportFromConfig(smtp) {
  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: { user: smtp.user, pass: smtp.pass },
  });
}

export async function verifySmtp(entity = {}, overrides = {}) {
  const merged = { ...entity };
  for (const key of ["smtp_host", "smtp_port", "smtp_user", "smtp_pass", "from_address"]) {
    if (overrides[key] != null && String(overrides[key]).trim() !== "") {
      merged[key] = overrides[key];
    }
  }
  const smtp = smtpConfig(merged);
  if (!smtp) {
    throw new Error(
      "Enter mailbox email, SMTP host, username, and password (App Password for Gmail) first."
    );
  }
  const transport = transportFromConfig(smtp);
  await transport.verify();
  return { ok: true, host: smtp.host, port: smtp.port, user: smtp.user, from: smtp.from };
}

export function mailStatus(entity = {}) {
  return {
    smtp_configured: Boolean(smtpConfig(entity)),
    outlook_available: process.platform === "win32",
  };
}

async function sendSmtp(entity, smtp, { to, subject, text, html, attachments = [] }) {
  const transport = transportFromConfig(smtp);
  const name = String(entity?.display_name || "Attest").replace(/"/g, "");
  await transport.sendMail({
    from: `"${name}" <${smtp.from}>`,
    to,
    subject,
    text,
    html,
    attachments,
  });
  return { via: `smtp:${smtp.host}` };
}

async function sendOutlook({ to, subject, text, html, from }) {
  const script = path.join(repoRoot, "scripts", "send-outlook-mail.ps1");
  if (!existsSync(script)) {
    throw new Error("Outlook send script is missing");
  }
  const payloadPath = path.join(os.tmpdir(), `attest-mail-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(payloadPath, JSON.stringify({ to, subject, text, html, from: from || "" }), "utf8");
  const powershell = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  try {
    const { stdout } = await execFileAsync(
      powershell,
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-PayloadPath", payloadPath],
      { timeout: 45000, windowsHide: true }
    );
    const line = String(stdout || "").trim().split(/\r?\n/).filter(Boolean).pop() || "";
    try {
      return JSON.parse(line);
    } catch {
      return { via: "outlook" };
    }
  } finally {
    try {
      unlinkSync(payloadPath);
    } catch {
      /* ignore */
    }
  }
}

export async function deliverMail({ entity, to, subject, text, html, attachments = [], allowOutlook = false }) {
  const smtp = smtpConfig(entity);
  if (smtp) {
    try {
      return await sendSmtp(entity, smtp, { to, subject, text, html, attachments });
    } catch (err) {
      throw new Error(`SMTP send failed (${err.message}). Check host, username, and App Password.`);
    }
  }
  if (allowOutlook && process.platform === "win32") {
    try {
      return await sendOutlook({
        to,
        subject,
        text,
        html,
        from: entity?.from_address,
      });
    } catch (err) {
      throw new Error(
        `Could not send via Outlook (${err.message}). Open the compliance company and add its mailbox login.`
      );
    }
  }
  throw new Error(
    `No sending mailbox saved. Open the compliance company and add its SMTP login.`
  );
}

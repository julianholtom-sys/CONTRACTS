import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "word-to-pdf.ps1");
const TIMEOUT_MS = 150000;

let queue = Promise.resolve();

function runWord(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, ...args],
      { windowsHide: true }
    );
    let stdout = "";
    let stderr = "";
    let wordPid = null;
    const timer = setTimeout(() => {
      // Only the Word this run started is stopped; any Word the user has open is left alone.
      if (wordPid) {
        try {
          process.kill(wordPid);
        } catch {
          /* already gone */
        }
      }
      child.kill();
      reject(new Error("Word took too long to make the PDF. Try again."));
    }, TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const match = stdout.match(/PID:(\d+)/);
      if (match) wordPid = Number(match[1]);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && /\bOK\b/.test(stdout)) resolve();
      else reject(new Error(`Word could not make the PDF: ${stderr.trim() || `exit ${code}`}`));
    });
  });
}

/**
 * Turns a filled Word file into a PDF with Microsoft Word, one file at a time.
 * With `marked`, also returns a copy that still shows the {{sig.*}} fields so their places can be read.
 */
export function convertDocxToPdf(docxBytes, { marked = false } = {}) {
  if (process.platform !== "win32") {
    return Promise.reject(new Error("Word templates need Microsoft Word on this computer to make the PDF"));
  }
  const job = queue.then(async () => {
    const dir = path.join(os.tmpdir(), "contract-builder-word");
    fs.mkdirSync(dir, { recursive: true });
    const id = randomUUID();
    const input = path.join(dir, `${id}.docx`);
    const output = path.join(dir, `${id}.pdf`);
    const markedOutput = path.join(dir, `${id}-marked.pdf`);
    fs.writeFileSync(input, docxBytes);
    try {
      await runWord(["-In", input, "-Out", output, ...(marked ? ["-Marked", markedOutput] : [])]);
      return {
        pdf: fs.readFileSync(output),
        markedPdf: marked ? fs.readFileSync(markedOutput) : null,
      };
    } finally {
      for (const file of [input, output, markedOutput]) fs.rmSync(file, { force: true });
    }
  });
  queue = job.catch(() => {});
  return job;
}

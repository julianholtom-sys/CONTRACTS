import { useRef } from "react";

function isPdf(name, mime) {
  const m = String(mime || "").toLowerCase();
  const n = String(name || "").toLowerCase();
  return m.includes("pdf") || n.endsWith(".pdf");
}

function isImage(name, mime) {
  const m = String(mime || "").toLowerCase();
  const n = String(name || "").toLowerCase();
  return m.startsWith("image/") || m.includes("svg") || /\.(svg|png|jpe?g|gif|webp)$/i.test(n);
}

export default function FileSlot({
  label,
  fileName,
  mime,
  present,
  previewUrl,
  accept,
  busy,
  uploadLabel,
  replaceLabel = "Replace",
  deleteLabel = "Delete",
  emptyText = "No file yet",
  onUpload,
  onDelete,
  children,
}) {
  const inputRef = useRef(null);
  const hasFile = Boolean(present);
  const kind = isPdf(fileName, mime) ? "pdf" : isImage(fileName, mime) ? "image" : "file";

  return (
    <div className={`brand-slot${hasFile ? " is-complete" : ""}`}>
      <div className="brand-slot-head">
        <h3>{label}</h3>
        <span className={`badge ${hasFile ? "completed" : "draft"}`}>
          {hasFile ? "Complete" : "Not set"}
        </span>
      </div>
      {hasFile ? (
        <div className="brand-slot-preview">
          {previewUrl && kind === "pdf" ? (
            <iframe className="asset-preview-frame" title={`${label} preview`} src={previewUrl} />
          ) : previewUrl && kind === "image" ? (
            <img className="asset-preview-img" src={previewUrl} alt={fileName || label} />
          ) : (
            <p className="muted">File uploaded</p>
          )}
          <div className="brand-slot-filemeta">
            <span className="meta">{fileName || "Uploaded file"}</span>
            <div className="brand-slot-actions">
              {previewUrl ? (
                <a className="btn secondary" href={previewUrl} target="_blank" rel="noreferrer">
                  Open
                </a>
              ) : null}
              {onUpload ? (
                <button
                  type="button"
                  className="btn secondary"
                  disabled={busy}
                  onClick={() => inputRef.current?.click()}
                >
                  {replaceLabel}
                </button>
              ) : null}
              {onDelete ? (
                <button
                  type="button"
                  className="btn danger"
                  disabled={busy}
                  onClick={onDelete}
                >
                  {deleteLabel}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : (
        <div className="brand-slot-empty">{emptyText}</div>
      )}
      {onUpload ? (
        <>
          {!hasFile ? (
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => inputRef.current?.click()}
            >
              {uploadLabel || `Upload ${label.toLowerCase()}`}
            </button>
          ) : null}
          <input
            ref={inputRef}
            className="file-slot-input"
            type="file"
            accept={accept}
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) onUpload(file);
            }}
          />
        </>
      ) : null}
      {children}
    </div>
  );
}

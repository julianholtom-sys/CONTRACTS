import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import ConfirmDialog from "./ConfirmDialog.jsx";

/** Sticky "Save progress" bar. While there are unsaved changes, leaving the page asks first. */
export default function SaveProgressBar({ dirty, saving, onSave }) {
  const navigate = useNavigate();
  const [leaveTo, setLeaveTo] = useState("");

  useEffect(() => {
    if (!dirty) return undefined;
    const onUnload = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const onClick = (event) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target.closest?.("a[href]");
      if (!link || link.target === "_blank" || link.hasAttribute("download")) return;
      const url = new URL(link.href, window.location.href);
      if (url.origin !== window.location.origin || url.pathname.startsWith("/api/")) return;
      if (url.pathname === window.location.pathname) return;
      event.preventDefault();
      event.stopPropagation();
      setLeaveTo(url.pathname + url.search + url.hash);
    };
    window.addEventListener("beforeunload", onUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [dirty]);

  return (
    <>
      <div className="save-bar">
        <span className="meta">{saving ? "Saving…" : dirty ? "Unsaved changes" : "All changes saved"}</span>
        <button className="btn" type="button" disabled={!dirty || saving} onClick={onSave}>
          {saving ? "Saving…" : "Save progress"}
        </button>
      </div>
      {leaveTo ? (
        <ConfirmDialog
          title="Unsaved changes"
          message="Leave this page without saving? Use Save progress to keep your changes."
          cancelLabel="Stay on this page"
          confirmLabel="Leave without saving"
          onCancel={() => setLeaveTo("")}
          onConfirm={() => {
            const target = leaveTo;
            setLeaveTo("");
            navigate(target);
          }}
        />
      ) : null}
    </>
  );
}

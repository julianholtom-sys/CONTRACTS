import { useEffect, useRef } from "react";
import {
  collectClipboardImages,
  extractGmailFragment,
  htmlToText,
  inlineSignatureImages,
  textToSimpleHtml,
} from "./gmailSignature.js";

export default function GmailSignatureEditor({ html, onChange, resolveImages }) {
  const ref = useRef(null);
  const lastSet = useRef("");

  useEffect(() => {
    if (!ref.current) return;
    const next = html || "";
    if (next !== lastSet.current) {
      ref.current.innerHTML = next;
      lastSet.current = next;
    }
  }, [html]);

  function emit(nextHtml, plain) {
    lastSet.current = nextHtml;
    onChange({
      html: nextHtml,
      text: plain || htmlToText(nextHtml),
    });
  }

  async function onPaste(event) {
    const files = collectClipboardImages(event.clipboardData);
    const clipHtml = event.clipboardData.getData("text/html");
    const clipText = event.clipboardData.getData("text/plain");
    if (!clipHtml && !clipText && !files.length) return;
    event.preventDefault();
    let nextHtml = clipHtml ? extractGmailFragment(clipHtml) : textToSimpleHtml(clipText);
    if (files.length || /<img\b/i.test(nextHtml) || resolveImages) {
      try {
        nextHtml = await inlineSignatureImages(nextHtml, files, {
          fetchRemote: resolveImages,
        });
      } catch {
        /* keep the pasted HTML when an image cannot be inlined */
      }
    }
    if (ref.current) ref.current.innerHTML = nextHtml;
    emit(nextHtml, clipText || htmlToText(nextHtml));
  }

  function onInput() {
    if (!ref.current) return;
    emit(ref.current.innerHTML);
  }

  return (
    <div
      ref={ref}
      className="gmail-signature-editor"
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      aria-label="Gmail signature"
      data-placeholder="Paste your Gmail signature here…"
      onPaste={onPaste}
      onInput={onInput}
    />
  );
}

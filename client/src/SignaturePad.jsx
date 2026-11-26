import { useEffect, useRef, useState } from "react";
import { registerSignatureFonts, SIGNATURE_FONTS } from "./signatureFonts.js";
import { imageFileSignature, trimCanvas, typedSignature } from "./signatureImage.js";

const MODES = [
  ["drawn", "Draw"],
  ["typed", "Type"],
  ["uploaded", "Upload image"],
];

function DrawPad({ onChange }) {
  const canvasRef = useRef(null);
  const drawing = useRef(false);
  const last = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ratio = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * ratio;
    canvas.height = rect.height * ratio;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#101828";
  }, []);

  function point(e) {
    const rect = canvasRef.current.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function capture(e, on) {
    try {
      canvasRef.current[on ? "setPointerCapture" : "releasePointerCapture"](e.pointerId);
    } catch {
      // Pointer already gone; drawing still works without capture.
    }
  }

  function stop(e) {
    if (!drawing.current) return;
    drawing.current = false;
    capture(e, false);
    const dataUrl = trimCanvas(canvasRef.current);
    onChange(dataUrl ? { dataUrl, method: "drawn" } : null);
  }

  return (
    <div className="sig-stack">
      <div className="sig-pad-wrap">
        <canvas
          ref={canvasRef}
          aria-label="Draw your signature"
          onPointerDown={(e) => {
            e.preventDefault();
            capture(e, true);
            drawing.current = true;
            last.current = point(e);
          }}
          onPointerMove={(e) => {
            if (!drawing.current) return;
            e.preventDefault();
            const ctx = canvasRef.current.getContext("2d");
            const p = point(e);
            ctx.beginPath();
            ctx.moveTo(last.current.x, last.current.y);
            ctx.lineTo(p.x, p.y);
            ctx.stroke();
            last.current = p;
          }}
          onPointerUp={stop}
          onPointerCancel={stop}
        />
      </div>
      <div>
        <button
          type="button"
          className="btn secondary"
          onClick={() => {
            const canvas = canvasRef.current;
            canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
            onChange(null);
          }}
        >
          Clear signature
        </button>
      </div>
    </div>
  );
}

/**
 * Draw, type in a handwriting font, or upload an image. Every route hands back a cropped PNG,
 * so the server and the PDF stamping treat them the same.
 */
export default function SignaturePad({ onChange, defaultName = "" }) {
  registerSignatureFonts();
  const [mode, setMode] = useState("drawn");
  const [drawn, setDrawn] = useState(null);
  const [typedText, setTypedText] = useState(defaultName);
  const [fontIndex, setFontIndex] = useState(0);
  const [typed, setTyped] = useState(null);
  const [uploaded, setUploaded] = useState(null);
  const [uploadError, setUploadError] = useState("");
  const [reading, setReading] = useState(false);

  const current = mode === "drawn" ? drawn : mode === "typed" ? typed : uploaded;

  useEffect(() => {
    onChange?.(current);
  }, [current]);

  useEffect(() => {
    if (mode !== "typed") return undefined;
    const text = typedText.trim();
    if (!text) {
      setTyped(null);
      return undefined;
    }
    let live = true;
    const font = SIGNATURE_FONTS[fontIndex];
    typedSignature(text, font).then((dataUrl) => {
      if (live) setTyped(dataUrl ? { dataUrl, method: "typed", text } : null);
    });
    return () => {
      live = false;
    };
  }, [mode, typedText, fontIndex]);

  async function onFile(file) {
    setUploadError("");
    setReading(true);
    try {
      setUploaded({ dataUrl: await imageFileSignature(file), method: "uploaded" });
    } catch (err) {
      setUploaded(null);
      setUploadError(err.message);
    } finally {
      setReading(false);
    }
  }

  const sample = typedText.trim() || "Your name";
  const fit = Math.min(1, 18 / sample.length);

  return (
    <div className="sig-input sig-stack">
      <div className="sig-tabs" role="tablist" aria-label="How to sign">
        {MODES.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={mode === id}
            className={`sig-tab${mode === id ? " active" : ""}`}
            onClick={() => setMode(id)}
          >
            {label}
          </button>
        ))}
      </div>

      <div hidden={mode !== "drawn"}>
        <DrawPad onChange={setDrawn} />
      </div>

      <div hidden={mode !== "typed"} className="sig-stack">
        <label>
          Name to sign with
          <input
            value={typedText}
            maxLength={60}
            onChange={(e) => setTypedText(e.target.value)}
            placeholder="Your full name"
          />
        </label>
        <div className="sig-fonts" role="radiogroup" aria-label="Handwriting style">
          {SIGNATURE_FONTS.map((font, index) => (
            <button
              key={font.family}
              type="button"
              role="radio"
              aria-checked={fontIndex === index}
              aria-label={`Handwriting style ${index + 1}`}
              className={`sig-font${fontIndex === index ? " active" : ""}`}
              style={{ fontFamily: `"${font.family}", cursive`, fontSize: `${1.9 * font.size * fit}rem` }}
              onClick={() => setFontIndex(index)}
            >
              {sample}
            </button>
          ))}
        </div>
      </div>

      <div hidden={mode !== "uploaded"} className="sig-stack">
        <p className="muted">
          A photo or scan of your signature on plain paper works best. The paper
          background is removed and the image is cropped to the signature.
        </p>
        <div>
          <label className="btn secondary sig-file">
            {reading ? "Reading the image…" : uploaded ? "Choose a different image" : "Choose an image"}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              disabled={reading}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) onFile(file);
                e.target.value = "";
              }}
            />
          </label>
        </div>
        {uploadError ? <p className="error">{uploadError}</p> : null}
      </div>

      {mode !== "drawn" && current ? (
        <div className="sig-preview">
          <span className="muted">How it will appear</span>
          <img src={current.dataUrl} alt="Your signature" />
        </div>
      ) : null}
    </div>
  );
}

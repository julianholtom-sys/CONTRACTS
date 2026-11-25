import { useEffect, useRef } from "react";

export default function SignaturePad({ onChange }) {
  const canvasRef = useRef(null);
  const drawing = useRef(false);
  const last = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ratio = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * ratio;
    canvas.height = rect.height * ratio;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#101828";
  }, []);

  function point(e) {
    const rect = canvasRef.current.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function emit() {
    onChange?.(canvasRef.current.toDataURL("image/png"));
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
    emit();
  }

  return (
    <div>
      <div className="sig-pad-wrap">
        <canvas
          ref={canvasRef}
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
            emit();
          }}
          onPointerUp={stop}
          onPointerCancel={stop}
        />
      </div>
      <button
        type="button"
        className="btn secondary"
        onClick={() => {
          const canvas = canvasRef.current;
          const ctx = canvas.getContext("2d");
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          onChange?.("");
        }}
      >
        Clear signature
      </button>
    </div>
  );
}

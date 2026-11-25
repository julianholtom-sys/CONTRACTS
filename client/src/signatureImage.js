const INK = "#101828";

/** Crops a canvas to its visible ink and returns a PNG data URL, or "" when it is blank. */
export function trimCanvas(source, pad = 8) {
  const { width, height } = source;
  if (!width || !height) return "";
  const data = source.getContext("2d").getImageData(0, 0, width, height).data;
  let top = height;
  let left = width;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  if (right < 0) return "";
  const x0 = Math.max(0, left - pad);
  const y0 = Math.max(0, top - pad);
  const w = Math.min(width, right + pad + 1) - x0;
  const h = Math.min(height, bottom + pad + 1) - y0;
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  out.getContext("2d").drawImage(source, x0, y0, w, h, 0, 0, w, h);
  return out.toDataURL("image/png");
}

export async function typedSignature(text, { family, size: scale = 1 }) {
  const size = Math.round(120 * scale);
  const font = `${size}px "${family}"`;
  await document.fonts.load(font, text);
  const probe = document.createElement("canvas").getContext("2d");
  probe.font = font;
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(probe.measureText(text).width + size * 2);
  canvas.height = size * 3;
  const ctx = canvas.getContext("2d");
  ctx.font = font;
  ctx.fillStyle = INK;
  ctx.textBaseline = "middle";
  ctx.fillText(text, size, canvas.height / 2);
  return trimCanvas(canvas, 6);
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("That image could not be opened"));
    };
    img.src = url;
  });
}

const luminance = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

/** Fades the paper to transparent so a photo of a signature sits cleanly on the document. */
function clearPaper(ctx, width, height) {
  const image = ctx.getImageData(0, 0, width, height);
  const d = image.data;
  let sum = 0;
  let count = 0;
  const sample = (x, y) => {
    const i = (y * width + x) * 4;
    if (d[i + 3] < 200) return;
    sum += luminance(d, i);
    count += 1;
  };
  for (let x = 0; x < width; x += 1) {
    sample(x, 0);
    sample(x, height - 1);
  }
  for (let y = 0; y < height; y += 1) {
    sample(0, y);
    sample(width - 1, y);
  }
  if (count < (width + height) / 2) return;
  const paper = sum / count;
  if (paper < 140) return;
  const clear = paper - 25;
  const solid = paper - 95;
  for (let i = 0; i < d.length; i += 4) {
    const lum = luminance(d, i);
    const keep = Math.min(1, Math.max(0, (clear - lum) / (clear - solid)));
    d[i + 3] = Math.round(d[i + 3] * keep);
  }
  ctx.putImageData(image, 0, 0);
}

export async function imageFileSignature(file) {
  if (!/^image\/(png|jpeg|webp)$/.test(file?.type || "")) {
    throw new Error("Choose a PNG, JPEG or WebP image");
  }
  if (file.size > 10 * 1024 * 1024) throw new Error("The image must be under 10 MB");
  const img = await loadImage(file);
  const scale = Math.min(1, 1600 / img.naturalWidth, 800 / img.naturalHeight);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  clearPaper(ctx, canvas.width, canvas.height);
  const dataUrl = trimCanvas(canvas, 6);
  if (!dataUrl) throw new Error("No signature was found in that image");
  return dataUrl;
}

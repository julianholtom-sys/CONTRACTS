import greatVibesLatin from "@fontsource/great-vibes/files/great-vibes-latin-400-normal.woff2?url";
import greatVibesLatinExt from "@fontsource/great-vibes/files/great-vibes-latin-ext-400-normal.woff2?url";
import dancingLatin from "@fontsource/dancing-script/files/dancing-script-latin-400-normal.woff2?url";
import dancingLatinExt from "@fontsource/dancing-script/files/dancing-script-latin-ext-400-normal.woff2?url";
import homemadeAppleLatin from "@fontsource/homemade-apple/files/homemade-apple-latin-400-normal.woff2?url";
import sacramentoLatin from "@fontsource/sacramento/files/sacramento-latin-400-normal.woff2?url";
import sacramentoLatinExt from "@fontsource/sacramento/files/sacramento-latin-ext-400-normal.woff2?url";
import mrDafoeLatin from "@fontsource/mr-dafoe/files/mr-dafoe-latin-400-normal.woff2?url";
import mrDafoeLatinExt from "@fontsource/mr-dafoe/files/mr-dafoe-latin-ext-400-normal.woff2?url";
import herrLatin from "@fontsource/herr-von-muellerhoff/files/herr-von-muellerhoff-latin-400-normal.woff2?url";
import herrLatinExt from "@fontsource/herr-von-muellerhoff/files/herr-von-muellerhoff-latin-ext-400-normal.woff2?url";

const LATIN =
  "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";
const LATIN_EXT =
  "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF";

/**
 * Bundled with the app so typed signatures render the same offline and on the phone demo.
 * Names must match SIGNATURE_FONTS in server/src/signatureInput.js.
 */
export const SIGNATURE_FONTS = [
  { family: "Great Vibes", size: 1, files: [greatVibesLatin, greatVibesLatinExt] },
  { family: "Dancing Script", size: 0.9, files: [dancingLatin, dancingLatinExt] },
  { family: "Homemade Apple", size: 0.72, files: [homemadeAppleLatin] },
  { family: "Sacramento", size: 1.05, files: [sacramentoLatin, sacramentoLatinExt] },
  { family: "Mr Dafoe", size: 1, files: [mrDafoeLatin, mrDafoeLatinExt] },
  { family: "Herr Von Muellerhoff", size: 1.1, files: [herrLatin, herrLatinExt] },
];

let registered = false;

/** Adds the faces once; the browser downloads each file only when its characters are drawn. */
export function registerSignatureFonts() {
  if (registered || typeof FontFace === "undefined") return;
  registered = true;
  for (const font of SIGNATURE_FONTS) {
    font.files.forEach((url, index) => {
      document.fonts.add(
        new FontFace(font.family, `url(${url}) format("woff2")`, {
          display: "swap",
          unicodeRange: index === 0 ? LATIN : LATIN_EXT,
        })
      );
    });
  }
}

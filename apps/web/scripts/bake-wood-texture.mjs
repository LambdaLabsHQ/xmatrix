// Bakes the wood material into one seamless raster tile:
//   node scripts/bake-wood-texture.mjs
// writes public/textures/wood.webp, a 400px CSS tile at 3x.
//
// The wood used to be two SVG feTurbulence maps painted at runtime. Chrome on
// a P3 Mac drew such an image without colour management whenever it was drawn
// once (an element no larger than its 400px tile) and with it when the tile
// repeated, so a short Summary plank came out walnut and the tall rail beside
// it a greyer wood from the same CSS. A raster image is colour-managed at
// every size. The tile is the plank grain with its growth rings over it (the
// recipe the Summary plank used), and each pixel is converted from Display P3
// to sRGB so the managed result is the walnut that plank showed. The maps
// below are the originals, kept as the source of the texture.
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const PLANK = `<svg xmlns='http://www.w3.org/2000/svg' width='1440' height='1440' viewBox='0 0 1440 1440'> <filter id='w' x='-8%' y='-8%' width='116%' height='116%' primitiveUnits='userSpaceOnUse' color-interpolation-filters='sRGB'> <feTurbulence type='fractalNoise' baseFrequency='0.14 0.007' numOctaves='4' seed='7' stitchTiles='stitch' x='0' y='0' width='1440' height='1440' result='G0'/> <feTile in='G0' result='G'/> <feTurbulence type='fractalNoise' baseFrequency='0.011' numOctaves='3' seed='23' stitchTiles='stitch' x='0' y='0' width='1440' height='1440' result='W0'/> <feTile in='W0' result='W'/> <feDisplacementMap in='G' in2='W' scale='50' xChannelSelector='R' yChannelSelector='G'/> <feColorMatrix type='saturate' values='0'/> <feComponentTransfer> <feFuncR type='table' tableValues='0.8 0.83 0.86 0.89 0.93'/> <feFuncG type='table' tableValues='0.63 0.66 0.7 0.73 0.77'/> <feFuncB type='table' tableValues='0.38 0.42 0.46 0.5 0.55'/> <feFuncA type='linear' slope='0' intercept='1'/> </feComponentTransfer> </filter> <rect width='1440' height='1440' filter='url(#w)'/> </svg>`;
const RINGS = `<svg xmlns='http://www.w3.org/2000/svg' width='1440' height='1440' viewBox='0 0 1440 1440'> <filter id='r' x='-8%' y='-8%' width='116%' height='116%' primitiveUnits='userSpaceOnUse' color-interpolation-filters='sRGB'> <feTurbulence type='fractalNoise' baseFrequency='0.045 0.002' numOctaves='2' seed='19' stitchTiles='stitch' x='0' y='0' width='1440' height='1440' result='R0'/> <feTile in='R0' result='R'/> <feTurbulence type='fractalNoise' baseFrequency='0.01' numOctaves='3' seed='31' stitchTiles='stitch' x='0' y='0' width='1440' height='1440' result='W0'/> <feTile in='W0' result='W'/> <feDisplacementMap in='R' in2='W' scale='80' xChannelSelector='R' yChannelSelector='G'/> <feComponentTransfer> <feFuncA type='table' tableValues='0 0 0.02 0.12 0.24'/> <feFuncR type='linear' slope='0' intercept='0.6'/> <feFuncG type='linear' slope='0' intercept='0.45'/> <feFuncB type='linear' slope='0' intercept='0.28'/> </feComponentTransfer> </filter> <rect width='1440' height='1440' filter='url(#r)'/> </svg>`;

const SIZE = 1200;
const QUALITY = 0.86;
const output = fileURLToPath(new URL("../public/textures/wood.webp", import.meta.url));

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const dataUrl = await page.evaluate(async ({ plank, rings, size, quality }) => {
    const load = (svg) => new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = `data:image/svg+xml,${encodeURIComponent(svg)}`;
    });
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d", { colorSpace: "srgb" });
    context.drawImage(await load(plank), 0, 0, size, size);
    context.drawImage(await load(rings), 0, 0, size, size);

    const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const toGamma = (c) => {
      const clamped = Math.min(1, Math.max(0, c));
      return clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;
    };
    const P3_TO_SRGB = [
      [1.2249401, -0.2249404, 0],
      [-0.0420569, 1.0420571, 0],
      [-0.0196376, -0.0786361, 1.0982735],
    ];
    const pixels = context.getImageData(0, 0, size, size);
    const data = pixels.data;
    for (let i = 0; i < data.length; i += 4) {
      const linear = [toLinear(data[i] / 255), toLinear(data[i + 1] / 255), toLinear(data[i + 2] / 255)];
      for (let channel = 0; channel < 3; channel += 1) {
        const [a, b, c] = P3_TO_SRGB[channel];
        data[i + channel] = Math.round(toGamma(a * linear[0] + b * linear[1] + c * linear[2]) * 255);
      }
      data[i + 3] = 255;
    }
    context.putImageData(pixels, 0, 0);
    return canvas.toDataURL("image/webp", quality);
  }, { plank: PLANK, rings: RINGS, size: SIZE, quality: QUALITY });
  await writeFile(output, Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64"));
  console.log(`wrote ${output}`);
} finally {
  await browser.close();
}

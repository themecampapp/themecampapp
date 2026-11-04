// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// Draws an instance's icon (open-source plan 3.5): initials in warm white on the app's night
// colour, the way the TCA icon was made, each size rendered at its own resolution. Writes
// favicon.ico (16, 32 and 48 px) and apple-touch-icon.png (180 px) to icons/<name>/; point the
// instance config's product.icon at <name>.
//   npx tsx scripts/make-icon.ts --initials EC --name example [--bg "#1a1714"] [--fg "#f7f3eb"]
//   npx tsx scripts/make-icon.ts --tent --name default     (the neutral default: a tent, no letters)
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import sharp from "sharp";

const ICONS = fileURLToPath(new URL("../icons/", import.meta.url));

type Mark = { initials: string } | { tent: true };

const escapeXml = (v: string) =>
  v.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

// One size's drawing. Small sizes get a heavier weight and less padding, so they stay legible.
export function iconSvg(mark: Mark, size: number, bg: string, fg: string) {
  const body =
    "tent" in mark
      ? `<path d="M${size * 0.5} ${size * 0.2} L${size * 0.84} ${size * 0.8} H${size * 0.16} Z M${size * 0.5} ${size * 0.48} L${size * 0.62} ${size * 0.8} H${size * 0.38} Z" fill="${fg}" fill-rule="evenodd"/>`
      : (() => {
          const text = mark.initials.toUpperCase();
          const scale = text.length === 1 ? 0.62 : text.length === 2 ? 0.48 : 0.36;
          const weight = size <= 32 ? 800 : 700;
          return `<text x="50%" y="50%" dy="0.35em" text-anchor="middle" font-family="DejaVu Sans, Helvetica, Arial, sans-serif" font-weight="${weight}" font-size="${Math.round(size * scale)}" fill="${fg}">${escapeXml(text)}</text>`;
        })();
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" fill="${bg}"/>${body}</svg>`;
}

// An .ico holding PNGs (every browser reads PNG entries): a 6-byte header, a 16-byte entry per
// image, then the images.
export function ico(images: Array<{ size: number; png: Buffer }>) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, i) => {
    const at = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, at);
    header.writeUInt8(size >= 256 ? 0 : size, at + 1);
    header.writeUInt16LE(1, at + 4); // colour planes
    header.writeUInt16LE(32, at + 6); // bits per pixel
    header.writeUInt32LE(png.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map((i) => i.png)]);
}

export async function makeIcon(mark: Mark, outDir: string, bg = "#1a1714", fg = "#f7f3eb") {
  const png = (size: number) =>
    sharp(Buffer.from(iconSvg(mark, size, bg, fg)))
      .png()
      .toBuffer();
  const sizes = [16, 32, 48];
  const images = await Promise.all(sizes.map(async (size) => ({ size, png: await png(size) })));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "favicon.ico"), ico(images));
  writeFileSync(join(outDir, "apple-touch-icon.png"), await png(180));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { values } = parseArgs({
    options: {
      initials: { type: "string" },
      tent: { type: "boolean", default: false },
      name: { type: "string" },
      bg: { type: "string" },
      fg: { type: "string" },
    },
  });
  const initials = values.initials?.trim();
  if (!values.name || !/^[a-z0-9-]+$/.test(values.name) || (!initials && !values.tent)) {
    console.error(
      "Usage: tsx scripts/make-icon.ts (--initials AB | --tent) --name <folder> [--bg #hex] [--fg #hex]",
    );
    process.exit(1);
  }
  if (initials && !/^[A-Za-z0-9]{1,3}$/.test(initials)) {
    console.error("--initials is 1 to 3 letters or digits");
    process.exit(1);
  }
  const outDir = join(ICONS, values.name);
  await makeIcon(initials ? { initials } : { tent: true }, outDir, values.bg, values.fg);
  console.log(`wrote ${outDir}/favicon.ico and apple-touch-icon.png`);
}

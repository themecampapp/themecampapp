// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { hasPhoto, logoKey, PEOPLE, photoKey, samplePassKey } from "./demo-data";

// The demo camp's files (R67, Lead workspace plan Unit 9): an illustrated avatar for most of
// its made-up people (initials on a colour, never a photo of anyone), and a sample Setup Access
// Pass. The sample is a real pass with the holder's name, ids, codes and barcodes removed and
// "SAMPLE — NOT A VALID PASS" across it, as an image-only PDF.

const COLOURS = ["#f4c95d", "#8ecae6", "#b5e48c", "#f6a5c0", "#cdb4db", "#ffb703", "#90be6d"];

async function avatar(i: number, playa: string) {
  const initials = playa
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">
    <rect width="512" height="512" fill="${COLOURS[i % COLOURS.length]}"/>
    <circle cx="256" cy="200" r="96" fill="rgba(255,255,255,0.45)"/>
    <ellipse cx="256" cy="470" rx="170" ry="140" fill="rgba(255,255,255,0.45)"/>
    <text x="256" y="232" font-family="Helvetica, Arial, sans-serif" font-size="96"
      font-weight="bold" fill="#1a1714" text-anchor="middle">${initials}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).webp({ quality: 80 }).toBuffer();
}

// Mirage Camp's logo (issue #64): a low sun on the horizon over shimmering heat lines. Square,
// with a clear background; the header shows the camp's name beside it.
export async function demoLogo() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="190" viewBox="0 52 240 166">
    <defs><clipPath id="sky"><rect width="240" height="124"/></clipPath></defs>
    <circle cx="120" cy="124" r="62" fill="#f08a5d" clip-path="url(#sky)"/>
    <g fill="none" stroke="#2ec4b6" stroke-linecap="round">
      <path d="M28 148 Q74 134 120 148 T212 148" stroke-width="13"/>
      <path d="M52 176 Q86 164 120 176 T188 176" stroke-width="11"/>
      <path d="M80 202 Q100 193 120 202 T160 202" stroke-width="9"/>
    </g>
  </svg>`;
  return sharp(Buffer.from(svg)).webp({ quality: 90 }).toBuffer();
}

export async function demoFiles(campId: string) {
  const files: Array<{ key: string; bytes: Uint8Array; contentType: string }> = [];
  for (const [i, [, playa]] of PEOPLE.entries()) {
    if (!hasPhoto(i)) continue;
    files.push({
      key: photoKey(campId, i),
      bytes: await avatar(i, playa),
      contentType: "image/webp",
    });
  }
  files.push({ key: logoKey(campId), bytes: await demoLogo(), contentType: "image/webp" });
  files.push({
    key: samplePassKey(campId),
    bytes: readFileSync(fileURLToPath(new URL("./demo-assets/sample-sap.pdf", import.meta.url))),
    contentType: "application/pdf",
  });
  return files;
}

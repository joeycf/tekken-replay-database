// One-off generator for the Tekken icon set (public/icons/*.png + favicon.ico),
// rasterized from the corner-cut favicon.svg so every size carries the brand
// mark. The app's public/ files override the engine's umbrella-branded
// defaults at the same paths (layer public inheritance) — the engine keeps
// its neutral set for other games. Committed output; rerun on a mark change.
//
// Run: npx tsx scripts/icons.ts

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SVG = join(ROOT, 'public', 'favicon.svg');
const OUT = join(ROOT, 'public', 'icons');

// engine-parity size set (modules/static-artifacts + the seo plugin reference
// exactly these filenames)
const SIZES = [16, 32, 48, 180, 512] as const;

/** Single-image ICO with an embedded PNG (valid since Vista; what modern
 *  favicon generators emit). 6-byte header + one 16-byte directory entry. */
function pngToIco(png: Buffer, size: number): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // one image
  const dir = Buffer.alloc(16);
  dir.writeUInt8(size >= 256 ? 0 : size, 0); // width (0 = 256)
  dir.writeUInt8(size >= 256 ? 0 : size, 1); // height
  dir.writeUInt8(0, 2); // palette
  dir.writeUInt8(0, 3); // reserved
  dir.writeUInt16LE(1, 4); // planes
  dir.writeUInt16LE(32, 6); // bpp
  dir.writeUInt32LE(png.length, 8); // image bytes
  dir.writeUInt32LE(22, 12); // offset (6 + 16)
  return Buffer.concat([header, dir, png]);
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const svg = await readFile(SVG);

  for (const size of SIZES) {
    const png = await sharp(svg, { density: (72 * size) / 64 })
      .resize(size, size)
      .png({ compressionLevel: 9 })
      .toBuffer();
    await writeFile(join(OUT, `favicon-${size}.png`), png);
    console.log(`  ✓ icons/favicon-${size}.png (${png.length}B)`);
  }

  const ico48 = await sharp(svg, { density: (72 * 48) / 64 })
    .resize(48, 48)
    .png({ compressionLevel: 9 })
    .toBuffer();
  const ico = pngToIco(ico48, 48);
  await writeFile(join(ROOT, 'public', 'favicon.ico'), ico);
  console.log(`  ✓ favicon.ico (48px PNG-in-ICO, ${ico.length}B)`);
}

main().catch((err) => {
  console.error('✖ icons.ts failed:', err);
  process.exit(1);
});

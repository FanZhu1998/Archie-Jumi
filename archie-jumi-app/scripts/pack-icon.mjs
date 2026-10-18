// Resize the selected imagegen artwork into Windows icon container formats.
import sharp from 'sharp';
import { writeFile } from 'node:fs/promises';

const png = await sharp('artwork/realistic/app-icon.png').resize(512, 512).png().toBuffer();
await writeFile('public/icon.png', png);
const sizes = [16, 32, 48, 64, 128, 256];
const entries = await Promise.all(sizes.map(size => sharp(png).resize(size, size).png().toBuffer()));
const header = Buffer.alloc(6 + sizes.length * 16);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
for (const [index, size] of sizes.entries()) {
  const cursor = 6 + index * 16;
  header[cursor] = header[cursor + 1] = size === 256 ? 0 : size;
  header.writeUInt16LE(1, cursor + 4);
  header.writeUInt16LE(32, cursor + 6);
  header.writeUInt32LE(entries[index].length, cursor + 8);
  header.writeUInt32LE(offset, cursor + 12);
  offset += entries[index].length;
}
await writeFile('public/icon.ico', Buffer.concat([header, ...entries]));

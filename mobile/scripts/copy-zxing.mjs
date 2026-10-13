// The phone browser's QR reader (iPhones in Safari) needs zxing_reader.wasm next to the web page.
// Run after `npx expo export --platform web`: copies it into the export folder (default dist/).
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
const out = process.argv[2] ?? 'dist';
copyFileSync(join('node_modules', 'zxing-wasm', 'dist', 'reader', 'zxing_reader.wasm'), join(out, 'zxing_reader.wasm'));
console.log(`zxing_reader.wasm copied to ${out}/`);

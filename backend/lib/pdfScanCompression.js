const { promisify } = require('node:util');
const { inflate, deflate } = require('node:zlib');
const { PDFDocument, PDFName, PDFNumber, PDFRawStream } = require('pdf-lib');

const inflateAsync = promisify(inflate);
const deflateAsync = promisify(deflate);
const name = (key) => PDFName.of(key);

// PNG Paeth prediction predicts each byte from decoded adjacent pixels.
// Store only the difference. PDF readers reconstruct the exact original RGB.
function predict(left, above, upperLeft) {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const diagonalDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= diagonalDistance) return left;
  return aboveDistance <= diagonalDistance ? above : upperLeft;
}

function filterRgbRows(rgb, width, height) {
  const stride = width * 3;
  const filtered = Buffer.allocUnsafe((stride + 1) * height);
  for (let row = 0; row < height; row++) {
    const start = row * stride;
    const target = row * (stride + 1);
    filtered[target] = 4; // Paeth row marker for PDF's PNG Predictor 15.
    for (let column = 0; column < stride; column++) {
      const index = start + column;
      const left = column >= 3 ? rgb[index - 3] : 0;
      const above = row > 0 ? rgb[index - stride] : 0;
      const upperLeft = row > 0 && column >= 3 ? rgb[index - stride - 3] : 0;
      filtered[target + 1 + column] = rgb[index] - predict(left, above, upperLeft);
    }
  }
  return filtered;
}

async function compactScanImages(original) {
  const pdf = await PDFDocument.load(original, { updateMetadata: false });
  let changed = false;
  for (const [ref, image] of pdf.context.enumerateIndirectObjects()) {
    if (!(image instanceof PDFRawStream)) continue;
    const dict = image.dict;
    if (dict.get(name('Subtype')) !== name('Image') ||
        dict.get(name('Filter')) !== name('FlateDecode') ||
        dict.has(name('DecodeParms')) ||
        dict.lookupMaybe(name('BitsPerComponent'), PDFNumber)?.asNumber() !== 8) continue;

    const width = dict.lookup(name('Width'), PDFNumber).asNumber();
    const height = dict.lookup(name('Height'), PDFNumber).asNumber();
    const pixels = width * height;
    if (!Number.isInteger(width) || !Number.isInteger(height) ||
        width < 1 || height < 1 || pixels < 1_000_000 || pixels > 16_000_000) continue;

    const sampleBytes = pixels * 3;
    const rgb = await inflateAsync(image.getContents(), { maxOutputLength: sampleBytes });
    if (rgb.length !== sampleBytes) continue;
    const packed = await deflateAsync(filterRgbRows(rgb, width, height), { level: 9 });
    if (packed.length >= image.getContentsSize()) continue;

    const replacement = dict.clone(pdf.context);
    replacement.set(name('DecodeParms'), pdf.context.obj({
      Predictor: 15, Colors: 3, BitsPerComponent: 8, Columns: width,
    }));
    pdf.context.assign(ref, PDFRawStream.of(replacement, packed));
    changed = true;
  }
  if (!changed) return original;
  const compacted = Buffer.from(await pdf.save());
  return compacted.length < original.length ? compacted : original;
}

module.exports = { compactScanImages };

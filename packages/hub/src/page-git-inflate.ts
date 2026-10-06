/**
 * zlib inflate (RFC 1950 around RFC 1951) that also reports how many input
 * bytes a stream used. A git packfile concatenates one zlib stream per object
 * with no lengths between them, so reading a pushed pack needs the end of each.
 * Web streams decompress but cannot say where a stream ended.
 */

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115,
  131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537,
  2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

class Huffman {
  readonly counts = new Uint16Array(16);
  readonly symbols: Uint16Array;
  constructor(lengths: ArrayLike<number>) {
    this.symbols = new Uint16Array(lengths.length);
    for (let i = 0; i < lengths.length; i++) this.counts[lengths[i]!]!++;
    this.counts[0] = 0;
    const offsets = new Uint16Array(16);
    for (let i = 1; i < 16; i++) offsets[i] = offsets[i - 1]! + this.counts[i - 1]!;
    for (let i = 0; i < lengths.length; i++) if (lengths[i]) this.symbols[offsets[lengths[i]!]!++] = i;
  }
}

const FIXED_LITERALS = new Huffman([...Array(144).fill(8), ...Array(112).fill(9), ...Array(24).fill(7), ...Array(8).fill(8)]);
const FIXED_DISTANCES = new Huffman(Array(30).fill(5));

class Reader {
  position: number;
  private bitBuffer = 0;
  private bitCount = 0;
  constructor(private readonly input: Uint8Array, start: number) { this.position = start; }

  bits(count: number): number {
    while (this.bitCount < count) {
      if (this.position >= this.input.length) throw new Error("truncated deflate stream");
      this.bitBuffer |= this.input[this.position++]! << this.bitCount;
      this.bitCount += 8;
    }
    const value = this.bitBuffer & ((1 << count) - 1);
    this.bitBuffer >>>= count;
    this.bitCount -= count;
    return value;
  }

  symbol(table: Huffman): number {
    let code = 0; let first = 0; let index = 0;
    for (let length = 1; length < 16; length++) {
      code |= this.bits(1);
      const count = table.counts[length]!;
      if (code - count < first) return table.symbols[index + (code - first)]!;
      index += count; first += count; first <<= 1; code <<= 1;
    }
    throw new Error("invalid Huffman code");
  }

  /** Drops the bits left in the current byte (stored blocks and the end of the stream are byte-aligned). */
  align(): void { this.bitBuffer = 0; this.bitCount = 0; }
}

/** Inflates the zlib stream at `start`; `end` is the offset just past it, checksum included. */
export function inflateAt(input: Uint8Array, start: number): { data: Uint8Array; end: number } {
  const header = (input[start]! << 8) | input[start + 1]!;
  if ((input[start]! & 0x0f) !== 8 || header % 31 !== 0 || (input[start + 1]! & 0x20)) {
    throw new Error("not a zlib stream");
  }
  const reader = new Reader(input, start + 2);
  let out = new Uint8Array(1024);
  let length = 0;
  const push = (byte: number) => {
    if (length === out.length) { const grown = new Uint8Array(out.length * 2); grown.set(out); out = grown; }
    out[length++] = byte;
  };
  for (let last = 0; !last;) {
    last = reader.bits(1);
    const type = reader.bits(2);
    if (type === 0) {
      reader.align();
      const at = reader.position;
      const size = input[at]! | (input[at + 1]! << 8);
      reader.position = at + 4;
      for (let i = 0; i < size; i++) push(input[reader.position + i]!);
      reader.position += size;
      continue;
    }
    let literals = FIXED_LITERALS; let distances = FIXED_DISTANCES;
    if (type === 2) {
      const literalCount = reader.bits(5) + 257;
      const distanceCount = reader.bits(5) + 1;
      const codeCount = reader.bits(4) + 4;
      const codeLengths = new Uint8Array(19);
      for (let i = 0; i < codeCount; i++) codeLengths[CODE_LENGTH_ORDER[i]!] = reader.bits(3);
      const codes = new Huffman(codeLengths);
      const lengths = new Uint8Array(literalCount + distanceCount);
      for (let i = 0; i < lengths.length;) {
        const symbol = reader.symbol(codes);
        if (symbol < 16) { lengths[i++] = symbol; continue; }
        const [repeat, value] = symbol === 16 ? [3 + reader.bits(2), lengths[i - 1]!]
          : symbol === 17 ? [3 + reader.bits(3), 0] : [11 + reader.bits(7), 0];
        lengths.fill(value, i, i + repeat);
        i += repeat;
      }
      literals = new Huffman(lengths.subarray(0, literalCount));
      distances = new Huffman(lengths.subarray(literalCount));
    } else if (type !== 1) throw new Error("invalid deflate block");
    for (;;) {
      const symbol = reader.symbol(literals);
      if (symbol < 256) { push(symbol); continue; }
      if (symbol === 256) break;
      const index = symbol - 257;
      const size = LENGTH_BASE[index]! + reader.bits(LENGTH_EXTRA[index]!);
      const distanceIndex = reader.symbol(distances);
      const distance = DIST_BASE[distanceIndex]! + reader.bits(DIST_EXTRA[distanceIndex]!);
      for (let i = 0; i < size; i++) push(out[length - distance]!);
    }
  }
  reader.align();
  return { data: out.slice(0, length), end: reader.position + 4 };
}

/**
 * Synchronous SHA-256 whose state can be saved between requests. A multipart upload's
 * parts reach the Hub in separate Worker requests; the platform digests
 * (`crypto.subtle`, `DigestStream`) cannot be resumed, and hashing the whole
 * object again after the last part would cost a Worker request's CPU budget
 * many times over. Every part but the last is a whole number of 64-byte
 * blocks, so between parts the state is exactly the eight working words, and
 * the byte count follows from the part number.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const INITIAL = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
const HEX = /^[0-9a-f]{64}$/u;

function hex(words: Uint32Array): string {
  let out = "";
  for (const word of words) out += word.toString(16).padStart(8, "0");
  return out;
}

export class ResumableSha256 {
  private readonly state = new Uint32Array(INITIAL);
  private readonly block = new Uint8Array(64);
  private readonly schedule = new Uint32Array(64);
  private pending = 0;
  private processed: number;

  /**
   * Resumes after `processedBytes` (a multiple of 64) whose state was saved by
   * `save()`; with no state, starts a new digest.
   */
  constructor(saved?: { state: string; processedBytes: number }) {
    this.processed = 0;
    if (!saved) return;
    if (!HEX.test(saved.state) || !Number.isSafeInteger(saved.processedBytes) ||
        saved.processedBytes <= 0 || saved.processedBytes % 64 !== 0) {
      throw new TypeError("SHA-256 state is invalid");
    }
    for (let index = 0; index < 8; index += 1) {
      this.state[index] = Number.parseInt(saved.state.slice(index * 8, index * 8 + 8), 16);
    }
    this.processed = saved.processedBytes;
  }

  get bytes(): number {
    return this.processed + this.pending;
  }

  update(data: Uint8Array): void {
    let offset = 0;
    if (this.pending > 0) {
      const take = Math.min(64 - this.pending, data.byteLength);
      this.block.set(data.subarray(0, take), this.pending);
      this.pending += take;
      offset = take;
      if (this.pending < 64) return;
      this.compress(this.block, 0);
      this.pending = 0;
    }
    for (; offset + 64 <= data.byteLength; offset += 64) this.compress(data, offset);
    if (offset < data.byteLength) {
      this.block.set(data.subarray(offset), 0);
      this.pending = data.byteLength - offset;
    }
  }

  /** The state to resume from; only on a block boundary, which every whole part ends on. */
  save(): string {
    if (this.pending !== 0) throw new TypeError("SHA-256 state is saved only on a block boundary");
    return hex(this.state);
  }

  /** The lowercase hex digest of everything hashed. */
  digest(): string {
    return hex(this.finish());
  }

  /** The raw 32-byte digest of everything hashed. */
  digestBytes(): Uint8Array {
    const words = this.finish();
    const output = new Uint8Array(32);
    const view = new DataView(output.buffer);
    for (let index = 0; index < 8; index += 1) view.setUint32(index * 4, words[index]!);
    return output;
  }

  private finish(): Uint32Array {
    const total = this.bytes;
    const tail = new Uint8Array(this.pending < 56 ? 64 : 128);
    tail.set(this.block.subarray(0, this.pending));
    tail[this.pending] = 0x80;
    const view = new DataView(tail.buffer);
    view.setUint32(tail.byteLength - 8, Math.floor(total / 0x20000000));
    view.setUint32(tail.byteLength - 4, (total * 8) >>> 0);
    const words = new Uint32Array(this.state);
    for (let offset = 0; offset < tail.byteLength; offset += 64) this.compressInto(words, tail, offset);
    return words;
  }

  private compress(data: Uint8Array, offset: number): void {
    this.compressInto(this.state, data, offset);
    this.processed += 64;
  }

  private compressInto(state: Uint32Array, data: Uint8Array, offset: number): void {
    const w = this.schedule;
    for (let index = 0; index < 16; index += 1) {
      const at = offset + index * 4;
      w[index] = (data[at]! << 24) | (data[at + 1]! << 16) | (data[at + 2]! << 8) | data[at + 3]!;
    }
    for (let index = 16; index < 64; index += 1) {
      const a = w[index - 15]!, b = w[index - 2]!;
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[index] = (w[index - 16]! + s0 + w[index - 7]! + s1) | 0;
    }
    let a = state[0]!, b = state[1]!, c = state[2]!, d = state[3]!;
    let e = state[4]!, f = state[5]!, g = state[6]!, h = state[7]!;
    for (let index = 0; index < 64; index += 1) {
      const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (h + s1 + ((e & f) ^ (~e & g)) + K[index]! + w[index]!) | 0;
      const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (s0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    state[0] = (state[0]! + a) | 0; state[1] = (state[1]! + b) | 0;
    state[2] = (state[2]! + c) | 0; state[3] = (state[3]! + d) | 0;
    state[4] = (state[4]! + e) | 0; state[5] = (state[5]! + f) | 0;
    state[6] = (state[6]! + g) | 0; state[7] = (state[7]! + h) | 0;
  }
}

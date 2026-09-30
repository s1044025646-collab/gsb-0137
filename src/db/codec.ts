/** Typed-array <-> Buffer blob codecs. Little-endian, machine-independent. */

export function f64ToBlob(a: Float64Array): Buffer {
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength);
}
export function blobToF64(b: Uint8Array): Float64Array {
  return new Float64Array(Buffer.from(b).buffer.slice(0));
}
export function i32ToBlob(a: Int32Array): Buffer {
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength);
}
export function blobToI32(b: Uint8Array): Int32Array {
  return new Int32Array(Buffer.from(b).buffer.slice(0));
}
export function u8ToBlob(a: Uint8Array): Buffer {
  return Buffer.from(a);
}
export function blobToU8(b: Uint8Array): Uint8Array {
  return new Uint8Array(Buffer.from(b));
}
export function maskToBlob(n: number, isNodata: (id: number) => boolean): Buffer {
  const bits = Buffer.alloc(Math.ceil(n / 8));
  for (let id = 0; id < n; id++) if (isNodata(id)) bits[id >> 3] |= 1 << (id & 7);
  return bits;
}
export function blobToMask(b: Uint8Array, n: number): Uint8Array {
  const mask = new Uint8Array(n);
  const buf = Buffer.from(b);
  for (let id = 0; id < n; id++) if ((buf[id >> 3] as number) & (1 << (id & 7))) mask[id] = 1;
  return mask;
}

export function statusListToBlob(statuses: string[]): Buffer {
  const map: Record<string, number> = {
    NODATA: 0,
    UNCHANGED: 1,
    RAISED: 2,
    FLAT_ROUTED: 3,
    CLOSED: 4,
    PIT: 5,
  };
  const buf = Buffer.alloc(statuses.length);
  statuses.forEach((s, i) => {
    buf[i] = map[s] ?? 1;
  });
  return buf;
}
const STATUS_NAMES = ["NODATA", "UNCHANGED", "RAISED", "FLAT_ROUTED", "CLOSED", "PIT"];
export function blobToStatusList(b: Uint8Array): string[] {
  const buf = Buffer.from(b);
  return Array.from(buf, (v) => STATUS_NAMES[v] ?? "UNCHANGED");
}

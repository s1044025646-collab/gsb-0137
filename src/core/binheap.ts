/**
 * Deterministic min-binary-heap keyed by (elevation, insertionSequence, id).
 * The insertion-sequence tie-break makes Priority-Flood processing order fully
 * reproducible across runs and independent of object/hash iteration order.
 */
export interface HeapEntry {
  id: number;
  key: number;
  seq: number;
}

export class MinHeap {
  private a: HeapEntry[] = [];
  private counter = 0;

  get size(): number {
    return this.a.length;
  }

  push(id: number, key: number): void {
    this.a.push({ id, key, seq: this.counter++ });
    let i = this.a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.less(this.a[i] as HeapEntry, this.a[p] as HeapEntry)) {
        this.swap(i, p);
        i = p;
      } else break;
    }
  }

  pop(): HeapEntry | undefined {
    const top = this.a[0];
    const last = this.a.pop();
    if (this.a.length > 0 && last !== undefined) {
      this.a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const rr = 2 * i + 2;
        let s = i;
        if (l < this.a.length && this.less(this.a[l] as HeapEntry, this.a[s] as HeapEntry)) s = l;
        if (rr < this.a.length && this.less(this.a[rr] as HeapEntry, this.a[s] as HeapEntry)) s = rr;
        if (s === i) break;
        this.swap(i, s);
        i = s;
      }
    }
    return top;
  }

  private less(x: HeapEntry, y: HeapEntry): boolean {
    if (x.key !== y.key) return x.key < y.key;
    if (x.seq !== y.seq) return x.seq < y.seq;
    return x.id < y.id;
  }

  private swap(i: number, j: number): void {
    const t = this.a[i] as HeapEntry;
    this.a[i] = this.a[j] as HeapEntry;
    this.a[j] = t;
  }
}

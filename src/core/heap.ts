/** Min-binary-heap keyed by a numeric priority, carrying integer payloads. */
export class MinHeap {
  private prio: number[] = [];
  private payload: number[] = [];

  get size(): number {
    return this.payload.length;
  }

  push(p: number, v: number): void {
    this.prio.push(p);
    this.payload.push(v);
    let i = this.payload.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.prio[parent] <= this.prio[i]) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): number {
    const top = this.payload[0];
    const lastP = this.prio.pop() as number;
    const lastV = this.payload.pop() as number;
    if (this.payload.length > 0) {
      this.prio[0] = lastP;
      this.payload[0] = lastV;
      let i = 0;
      const n = this.payload.length;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let smallest = i;
        if (l < n && this.prio[l] < this.prio[smallest]) smallest = l;
        if (r < n && this.prio[r] < this.prio[smallest]) smallest = r;
        if (smallest === i) break;
        this.swap(i, smallest);
        i = smallest;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    const tp = this.prio[a];
    this.prio[a] = this.prio[b];
    this.prio[b] = tp;
    const tv = this.payload[a];
    this.payload[a] = this.payload[b];
    this.payload[b] = tv;
  }
}

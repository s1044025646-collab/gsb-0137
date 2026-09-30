import { gridFromMatrix } from "../src/core/grid.ts";

/** Uniform single slope toward the bottom edge. */
export function singleSlope() {
  const m: number[][] = [];
  for (let r = 0; r < 5; r++) {
    const row: number[] = [];
    for (let c = 0; c < 5; c++)
      row.push(r === 4 ? 0 : (4 - r) * 10 + c);
    m.push(row);
  }
  return gridFromMatrix(m, 1, null);
}

/** Two valleys converging near the bottom centre. */
export function twoValleys() {
  const m = [
    [9, 8, 7, 8, 9],
    [8, 6, 5, 6, 8],
    [7, 5, 3, 5, 7],
    [8, 6, 2, 6, 8],
    [9, 8, 1, 8, 9],
  ];
  return gridFromMatrix(m, 2, null);
}

/** A closed depression enclosed by a higher ring, with boundary outlet far. */
export function closedDepression() {
  const m = [
    [9, 9, 9, 9, 9],
    [9, 8, 8, 8, 9],
    [9, 8, 0, 8, 9],
    [9, 8, 8, 8, 9],
    [9, 9, 9, 9, 9],
  ];
  return gridFromMatrix(m, 1, null);
}

/** Large flat plateau that must resolve deterministically without cycles. */
export function bigFlat() {
  const m: number[][] = [];
  for (let r = 0; r < 6; r++) {
    const row: number[] = [];
    for (let c = 0; c < 6; c++) row.push(r === 5 ? 0 : 5);
    m.push(row);
  }
  return gridFromMatrix(m, 1, null);
}

/** NoData hole in the middle; values must not treat hole as low ground. */
export function noDataHole() {
  const m: any = [
    [5, 5, 5, 5, 5],
    [5, 4, 4, 4, 5],
    [5, 4, -99, 4, 5],
    [5, 4, 4, 4, 5],
    [5, 5, 5, 5, 5],
  // add a boundary low so water drains
  ];
  m[0][2] = 1;
  return gridFromMatrix(m, 1, -99);
}

/** Boundary outlet: a notch on the top edge drains the whole slope. */
export function boundaryOutlet() {
  const m = [
    [5, 1, 5],
    [6, 5, 6],
    [7, 6, 7],
  ];
  return gridFromMatrix(m, 1, null);
}

/** A valid region fully enclosed by a NoData ring (no external route). */
export function nodataEnclosed() {
  const m: any = [
    [null, null, null, null, null],
    [null, 3, 3, 3, null],
    [null, 3, 1, 3, null],
    [null, 3, 3, 3, null],
    [null, null, null, null, null],
  ];
  return gridFromMatrix(m, 1, null);
}

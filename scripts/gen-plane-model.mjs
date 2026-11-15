// Generates a small low-poly aircraft model (glTF binary) for the 3D map.
// Our own asset (MIT). glTF axes: +Y up, +Z forward, +X left. Units: metres.
// Output: src/renderer/public/models/plane.glb
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Boxes in aircraft axes (fwd, left, up): [minF, maxF, minL, maxL, minU, maxU]
const parts = {
  body:   { color: [0.92, 0.93, 0.95, 1], boxes: [[-0.70, 0.40, -0.06, 0.06, -0.06, 0.06], [0.40, 0.50, -0.04, 0.04, -0.04, 0.04]] },
  accent: { color: [1.00, 0.48, 0.27, 1], boxes: [
    [-0.06, 0.17, -0.75, 0.75, 0.055, 0.075],   // wing (high wing)
    [-0.70, -0.55, -0.25, 0.25, 0.00, 0.015],   // horizontal tail
    [-0.72, -0.55, -0.008, 0.008, 0.015, 0.22], // vertical fin
  ] },
  left:   { color: [0.95, 0.15, 0.15, 1], boxes: [[-0.04, 0.15, 0.72, 0.78, 0.05, 0.08]] },  // red = left (port)
  right:  { color: [0.15, 0.85, 0.30, 1], boxes: [[-0.04, 0.15, -0.78, -0.72, 0.05, 0.08]] }, // green = right
};

// aircraft (f, l, u) → glTF (x=left, y=up, z=forward)
const toGltf = ([f, l, u]) => [l, u, f];

function boxMesh([f0, f1, l0, l1, u0, u1]) {
  const P = [], N = [], I = [];
  const faces = [
    { n: [1, 0, 0], q: [[f1, l0, u0], [f1, l1, u0], [f1, l1, u1], [f1, l0, u1]] },
    { n: [-1, 0, 0], q: [[f0, l1, u0], [f0, l0, u0], [f0, l0, u1], [f0, l1, u1]] },
    { n: [0, 1, 0], q: [[f1, l1, u0], [f0, l1, u0], [f0, l1, u1], [f1, l1, u1]] },
    { n: [0, -1, 0], q: [[f0, l0, u0], [f1, l0, u0], [f1, l0, u1], [f0, l0, u1]] },
    { n: [0, 0, 1], q: [[f0, l0, u1], [f1, l0, u1], [f1, l1, u1], [f0, l1, u1]] },
    { n: [0, 0, -1], q: [[f0, l1, u0], [f1, l1, u0], [f1, l0, u0], [f0, l0, u0]] },
  ];
  for (const { n, q } of faces) {
    const base = P.length / 3;
    for (const v of q) { P.push(...toGltf(v)); N.push(...toGltf(n)); }
    // Quads are counter-clockwise seen from outside, and (f,l,u)→(l,u,f) is a
    // rotation (cyclic permutation), so the glTF winding stays counter-clockwise.
    I.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { P, N, I };
}

const bufs = [];
let byteOffset = 0;
const bufferViews = [], accessors = [], primitives = [], materials = [];
const push = (typed, target) => {
  const pad = (4 - (typed.byteLength % 4)) % 4;
  bufferViews.push({ buffer: 0, byteOffset, byteLength: typed.byteLength, target });
  bufs.push(Buffer.from(typed.buffer), Buffer.alloc(pad));
  byteOffset += typed.byteLength + pad;
  return bufferViews.length - 1;
};

for (const [name, part] of Object.entries(parts)) {
  const P = [], N = [], I = [];
  for (const b of part.boxes) {
    const m = boxMesh(b);
    const base = P.length / 3;
    P.push(...m.P); N.push(...m.N); I.push(...m.I.map((i) => i + base));
  }
  const pos = new Float32Array(P), nor = new Float32Array(N), idx = new Uint16Array(I);
  const min = [0, 1, 2].map((k) => Math.min(...P.filter((_, i) => i % 3 === k)));
  const max = [0, 1, 2].map((k) => Math.max(...P.filter((_, i) => i % 3 === k)));
  accessors.push({ bufferView: push(pos, 34962), componentType: 5126, count: pos.length / 3, type: 'VEC3', min, max });
  accessors.push({ bufferView: push(nor, 34962), componentType: 5126, count: nor.length / 3, type: 'VEC3' });
  accessors.push({ bufferView: push(idx, 34963), componentType: 5123, count: idx.length, type: 'SCALAR' });
  materials.push({ name, doubleSided: true, pbrMetallicRoughness: { baseColorFactor: part.color, metallicFactor: 0.1, roughnessFactor: 0.6 } });
  const a = accessors.length;
  primitives.push({ attributes: { POSITION: a - 3, NORMAL: a - 2 }, indices: a - 1, material: materials.length - 1 });
}

const bin = Buffer.concat(bufs);
const gltf = {
  asset: { version: '2.0', generator: 'HuskyLog gen-plane-model' },
  scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name: 'aircraft' }],
  meshes: [{ primitives }], materials, accessors, bufferViews, buffers: [{ byteLength: bin.length }],
};
let json = Buffer.from(JSON.stringify(gltf));
json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
const chunk = (type, data) => { const h = Buffer.alloc(8); h.writeUInt32LE(data.length, 0); h.writeUInt32LE(type, 4); return Buffer.concat([h, data]); };
const glb = Buffer.concat([header, chunk(0x4e4f534a, json), chunk(0x004e4942, bin)]);
const out = join(import.meta.dirname, '..', 'src', 'renderer', 'public', 'models');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'plane.glb'), glb);
console.log('wrote plane.glb', glb.length, 'bytes');

// Generates a minimal, valid USDZ of a home-battery box so the proposal's 3D
// slide can offer real AR on iPhone/iPad (model-viewer `ios-src` → Apple Quick
// Look, which requires USDZ — it can't use the GLB the Android/WebXR path uses).
//
// USDZ is an *uncompressed* zip whose first file is the default USD layer, with
// every file's data aligned to a 64-byte boundary (Quick Look requirement). We
// hand-author an ASCII USDA cube with per-face normals + a UsdPreviewSurface
// material, then pack it into a spec-compliant zip ourselves (no USD toolchain
// available in this environment).
//
//   node scripts/gen-battery-usdz.mjs
//   → youtilityknock-web/public/battery.usdz
import { writeFileSync } from "node:fs";
import { crc32 } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, "../youtilityknock-web/public/battery.usdz");

// ── Box geometry (a wall battery: 0.6 W × 1.0 H × 0.2 D metres, base at y=0) ──
const W = 0.3, H = 1.0, D = 0.1; // half-width, full-height, half-depth
// 8 corners
const c = [
  [-W, 0, D], [W, 0, D], [W, H, D], [-W, H, D], // front (+z)
  [-W, 0, -D], [W, 0, -D], [W, H, -D], [-W, H, -D], // back (-z)
];
// 6 faces as quads (CCW when viewed from outside), each with its outward normal
const faces = [
  { idx: [0, 1, 2, 3], n: [0, 0, 1] }, // front
  { idx: [5, 4, 7, 6], n: [0, 0, -1] }, // back
  { idx: [1, 5, 6, 2], n: [1, 0, 0] }, // right
  { idx: [4, 0, 3, 7], n: [-1, 0, 0] }, // left
  { idx: [3, 2, 6, 7], n: [0, 1, 0] }, // top
  { idx: [4, 5, 1, 0], n: [0, -1, 0] }, // bottom
];
// Expand to 24 face-varying verts so each face shades flat & correct.
const points = [];
const normals = [];
for (const f of faces) {
  for (const vi of f.idx) {
    points.push(c[vi]);
    normals.push(f.n);
  }
}
const fvCounts = faces.map(() => 4).join(", ");
const fvIndices = points.map((_, i) => i).join(", ");
const ptStr = points.map((p) => `(${p.join(", ")})`).join(", ");
const nStr = normals.map((n) => `(${n.join(", ")})`).join(", ");

const USDA = `#usda 1.0
(
    defaultPrim = "Battery"
    metersPerUnit = 1
    upAxis = "Y"
)

def Xform "Battery" (kind = "component")
{
    def Mesh "Body"
    {
        uniform token subdivisionScheme = "none"
        int[] faceVertexCounts = [${fvCounts}]
        int[] faceVertexIndices = [${fvIndices}]
        point3f[] points = [${ptStr}]
        normal3f[] normals = [${nStr}] (interpolation = "faceVarying")
        rel material:binding = </Battery/BodyMat>
    }

    def Material "BodyMat"
    {
        token outputs:surface.connect = </Battery/BodyMat/PBR.outputs:surface>

        def Shader "PBR"
        {
            uniform token info:id = "UsdPreviewSurface"
            color3f inputs:diffuseColor = (0.36, 0.27, 0.55)
            float inputs:metallic = 0.55
            float inputs:roughness = 0.32
            float inputs:clearcoat = 0.4
            token outputs:surface
        }
    }
}
`;

// ── Pack a single-file, 64-byte-aligned, stored (uncompressed) zip = USDZ ─────
const name = Buffer.from("battery.usda", "ascii");
const data = Buffer.from(USDA, "utf8");
const crc = crc32(data) >>> 0;

// Local file header is 30 bytes + name + extra. The file *data* must begin at a
// 64-byte boundary, so size the extra field to pad it there.
const baseHeader = 30 + name.length; // before extra field
const need = (64 - (baseHeader % 64)) % 64;
// extra field must be ≥4 bytes (2 id + 2 len); bump by 64 if we need a few bytes
let extraLen = need;
while (extraLen > 0 && extraLen < 4) extraLen += 64;
const extra = Buffer.alloc(extraLen);
if (extraLen >= 4) {
  extra.writeUInt16LE(0x1986, 0); // arbitrary app-defined id (Quick Look ignores)
  extra.writeUInt16LE(extraLen - 4, 2); // payload length
}

function dosTime() {
  // Fixed timestamp (no Date.* in this env-friendly script): 2024-01-01 00:00.
  const time = 0; // 00:00:00
  const date = ((2024 - 1980) << 9) | (1 << 5) | 1;
  return { time, date };
}
const { time, date } = dosTime();

const local = Buffer.alloc(30);
local.writeUInt32LE(0x04034b50, 0); // local file header sig
local.writeUInt16LE(20, 4); // version needed
local.writeUInt16LE(0, 6); // flags
local.writeUInt16LE(0, 8); // method 0 = store
local.writeUInt16LE(time, 10);
local.writeUInt16LE(date, 12);
local.writeUInt32LE(crc, 14);
local.writeUInt32LE(data.length, 18); // compressed size
local.writeUInt32LE(data.length, 22); // uncompressed size
local.writeUInt16LE(name.length, 26);
local.writeUInt16LE(extra.length, 28);

const localOffset = 0;
const fileData = Buffer.concat([local, name, extra, data]);

// Central directory record
const central = Buffer.alloc(46);
central.writeUInt32LE(0x02014b50, 0); // central dir sig
central.writeUInt16LE(20, 4); // version made by
central.writeUInt16LE(20, 6); // version needed
central.writeUInt16LE(0, 8); // flags
central.writeUInt16LE(0, 10); // method store
central.writeUInt16LE(time, 12);
central.writeUInt16LE(date, 14);
central.writeUInt32LE(crc, 16);
central.writeUInt32LE(data.length, 20);
central.writeUInt32LE(data.length, 24);
central.writeUInt16LE(name.length, 28);
central.writeUInt16LE(0, 30); // extra len (central) — keep 0
central.writeUInt16LE(0, 32); // comment len
central.writeUInt16LE(0, 34); // disk number
central.writeUInt16LE(0, 36); // internal attrs
central.writeUInt32LE(0, 38); // external attrs
central.writeUInt32LE(localOffset, 42); // offset of local header
const centralFull = Buffer.concat([central, name]);

const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0); // EOCD sig
eocd.writeUInt16LE(0, 4); // disk
eocd.writeUInt16LE(0, 6); // disk w/ CD
eocd.writeUInt16LE(1, 8); // entries this disk
eocd.writeUInt16LE(1, 10); // entries total
eocd.writeUInt32LE(centralFull.length, 12); // CD size
eocd.writeUInt32LE(fileData.length, 16); // CD offset
eocd.writeUInt16LE(0, 20); // comment len

const usdz = Buffer.concat([fileData, centralFull, eocd]);
writeFileSync(OUT, usdz);

const dataOffset = 30 + name.length + extra.length;
console.log(`Wrote ${OUT} (${usdz.length} bytes); USDA ${data.length} bytes; data offset ${dataOffset} (aligned: ${dataOffset % 64 === 0})`);

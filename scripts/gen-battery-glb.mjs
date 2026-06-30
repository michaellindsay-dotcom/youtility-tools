import { writeFileSync } from "node:fs";
// Minimal binary glTF (GLB) of a battery-proportioned box, single PBR material.
// model-viewer loads this for the 3D view + AR; recolored per product at runtime.
const W=0.6,H=1.0,D=0.2, hx=W/2,hy=H/2,hz=D/2;
// 6 faces × 4 verts, per-face normals
const faces=[
 {n:[0,0,1], v:[[-hx,-hy,hz],[hx,-hy,hz],[hx,hy,hz],[-hx,hy,hz]]},   // +Z front
 {n:[0,0,-1],v:[[hx,-hy,-hz],[-hx,-hy,-hz],[-hx,hy,-hz],[hx,hy,-hz]]},// -Z back
 {n:[1,0,0], v:[[hx,-hy,hz],[hx,-hy,-hz],[hx,hy,-hz],[hx,hy,hz]]},    // +X
 {n:[-1,0,0],v:[[-hx,-hy,-hz],[-hx,-hy,hz],[-hx,hy,hz],[-hx,hy,-hz]]},// -X
 {n:[0,1,0], v:[[-hx,hy,hz],[hx,hy,hz],[hx,hy,-hz],[-hx,hy,-hz]]},    // +Y top
 {n:[0,-1,0],v:[[-hx,-hy,-hz],[hx,-hy,-hz],[hx,-hy,hz],[-hx,-hy,hz]]},// -Y bottom
];
const pos=[],nor=[],idx=[];
faces.forEach((f,fi)=>{ f.v.forEach(v=>{pos.push(...v);nor.push(...f.n);}); const b=fi*4; idx.push(b,b+1,b+2, b,b+2,b+3); });
const posA=new Float32Array(pos), norA=new Float32Array(nor), idxA=new Uint16Array(idx);
// min/max for POSITION accessor
const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
for(let i=0;i<posA.length;i+=3){for(let k=0;k<3;k++){min[k]=Math.min(min[k],posA[i+k]);max[k]=Math.max(max[k],posA[i+k]);}}
const align=n=>(n+3)&~3;
const posBytes=posA.byteLength, norBytes=norA.byteLength, idxBytes=idxA.byteLength;
const posOff=0, norOff=align(posOff+posBytes), idxOff=align(norOff+norBytes), total=align(idxOff+idxBytes);
const bin=Buffer.alloc(total);
Buffer.from(posA.buffer).copy(bin,posOff);
Buffer.from(norA.buffer).copy(bin,norOff);
Buffer.from(idxA.buffer).copy(bin,idxOff);
const gltf={
 asset:{version:"2.0",generator:"youtility-battery-glb"},
 scenes:[{nodes:[0]}], scene:0,
 nodes:[{mesh:0,name:"Battery"}],
 meshes:[{primitives:[{attributes:{POSITION:0,NORMAL:1},indices:2,material:0}]}],
 materials:[{name:"Shell",pbrMetallicRoughness:{baseColorFactor:[0.82,0.83,0.88,1],metallicFactor:0.35,roughnessFactor:0.45}}],
 buffers:[{byteLength:total}],
 bufferViews:[
  {buffer:0,byteOffset:posOff,byteLength:posBytes,target:34962},
  {buffer:0,byteOffset:norOff,byteLength:norBytes,target:34962},
  {buffer:0,byteOffset:idxOff,byteLength:idxBytes,target:34963},
 ],
 accessors:[
  {bufferView:0,componentType:5126,count:posA.length/3,type:"VEC3",min,max},
  {bufferView:1,componentType:5126,count:norA.length/3,type:"VEC3"},
  {bufferView:2,componentType:5123,count:idxA.length,type:"SCALAR"},
 ],
};
let json=Buffer.from(JSON.stringify(gltf),"utf8");
const jpad=align(json.length)-json.length; if(jpad)json=Buffer.concat([json,Buffer.alloc(jpad,0x20)]);
const bpad=align(bin.length)-bin.length; const binC=bpad?Buffer.concat([bin,Buffer.alloc(bpad,0)]):bin;
const glbLen=12+8+json.length+8+binC.length;
const header=Buffer.alloc(12); header.writeUInt32LE(0x46546C67,0); header.writeUInt32LE(2,4); header.writeUInt32LE(glbLen,8);
const jh=Buffer.alloc(8); jh.writeUInt32LE(json.length,0); jh.writeUInt32LE(0x4E4F534A,4);
const bh=Buffer.alloc(8); bh.writeUInt32LE(binC.length,0); bh.writeUInt32LE(0x004E4942,4);
const glb=Buffer.concat([header,jh,json,bh,binC]);
writeFileSync("youtilityknock-web/public/battery.glb",glb);
console.log("wrote youtilityknock-web/public/battery.glb",glb.length,"bytes");

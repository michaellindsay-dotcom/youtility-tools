// Type shim for leaflet-rotate (ships no types). It patches Leaflet's Map with
// rotation support and adds a few map options we use.
declare module "leaflet-rotate";

import "leaflet";
declare module "leaflet" {
  interface MapOptions {
    rotate?: boolean;
    rotateControl?: boolean | { closeOnZeroBearing?: boolean };
    touchRotate?: boolean;
    shiftKeyRotate?: boolean;
    bearing?: number;
  }
  interface Map {
    setBearing(theta: number): this;
    getBearing(): number;
  }
}

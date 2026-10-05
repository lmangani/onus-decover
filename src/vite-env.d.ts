/// <reference types="vite/client" />

interface Navigator {
  deviceMemory?: number;
  gpu?: GPU;
}

declare module "lamejs/src/js/MPEGMode.js" {
  const value: unknown;
  export default value;
}

declare module "lamejs/src/js/Lame.js" {
  const value: unknown;
  export default value;
}

declare module "lamejs/src/js/BitStream.js" {
  const value: unknown;
  export default value;
}

declare module "lamejs" {
  export class Mp3Encoder {
    constructor(channels: number, sampleRate: number, kbps: number);
    encodeBuffer(left: Int16Array, right?: Int16Array): Int8Array;
    flush(): Int8Array;
  }
}

declare module 'bs58' {
  function encode(source: Uint8Array | Buffer): string;
  function decode(string: string): Uint8Array;
  export { encode, decode };
  export default { encode, decode };
}

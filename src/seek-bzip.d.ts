/** seek-bzip ships no types; this is the one call we make. */
declare module "seek-bzip" {
	const Bunzip: {
		decode(input: Uint8Array | Buffer): Buffer;
	};
	export default Bunzip;
}

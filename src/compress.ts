/**
 * Decompressing the tar members of a .deb.
 *
 * deb(5) allows six encodings and the producer chooses; a reader that handles
 * only the fashionable one stops working on old packages without saying so.
 * gzip and zstd are Bun built-ins, xz is a WebAssembly decoder embedded in the
 * compiled binary, and bzip2 is kept because packages using it are still in the
 * archive — `gbrowse-calign` in wheezy, for one.
 *
 * Everything streams except bzip2, whose decoder is one-shot. A 40 MB .deb can
 * hold 1.6 GB of tar, so streaming is not a nicety; the bzip2 path is bounded
 * instead, which costs nothing real because bzip2 fell out of use long before
 * packages grew that large.
 */

import Bunzip from "seek-bzip";
import { XzReadableStream } from "xz-decompress";

/** bzip2 must be held whole to be decoded, so refuse a member too big to hold. */
const BZIP2_LIMIT = 64 * 1024 * 1024;

/** The suffix after `.tar`, which is how deb(5) names the encoding. */
export function compressionOf(memberName: string): string {
	const at = memberName.indexOf(".tar");
	if (at === -1) throw new Error(`not a tar member: ${memberName}`);
	return memberName.slice(at + 4);
}

/** Wrap a member's bytes in whatever decoder its name calls for. */
export function decompressStream(memberName: string, src: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
	const ext = compressionOf(memberName);
	switch (ext) {
		case "":
			return src;
		case ".gz":
			return src.pipeThrough(through("gzip"));
		case ".zst":
			return src.pipeThrough(through("zstd"));
		case ".xz":
			return new XzReadableStream(src) as ReadableStream<Uint8Array>;
		case ".bz2":
			return bzip2Stream(src);
		case ".lzma":
			// Permitted by deb(5) and deprecated by dpkg, which reads it but has
			// never written it. Carrying a decoder last released in 2013 for a
			// format nothing produces is a worse trade than saying so plainly.
			throw new Error("this .deb uses lzma compression, which is not supported; unpack it with dpkg-deb instead");
		default:
			throw new Error(`unknown compression ${ext} on member ${memberName}`);
	}
}

export async function decompressBytes(memberName: string, bytes: Uint8Array): Promise<Uint8Array> {
	const one = new ReadableStream<Uint8Array>({
		start(c) {
			c.enqueue(bytes);
			c.close();
		},
	});
	return collect(decompressStream(memberName, one));
}

/** DecompressionStream is typed as taking any BufferSource; we only ever feed it bytes. */
function through(format: "gzip" | "zstd"): ReadableWritablePair<Uint8Array, Uint8Array> {
	return new DecompressionStream(format) as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
}

function bzip2Stream(src: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		async start(controller) {
			try {
				const packed = await collect(src, BZIP2_LIMIT);
				controller.enqueue(new Uint8Array(Bunzip.decode(Buffer.from(packed))));
				controller.close();
			} catch (e) {
				controller.error(e);
			}
		},
	});
}

async function collect(src: ReadableStream<Uint8Array>, limit?: number): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	let n = 0;
	for await (const chunk of src) {
		n += chunk.byteLength;
		if (limit && n > limit) throw new Error(`bzip2 member is larger than ${limit / 1024 / 1024} MiB; unpack it with dpkg-deb instead`);
		chunks.push(chunk);
	}
	const out = new Uint8Array(n);
	let at = 0;
	for (const c of chunks) {
		out.set(c, at);
		at += c.byteLength;
	}
	return out;
}

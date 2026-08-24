/** Small shared helpers. */

/** Print a message and stop. Every failure in this tool is fatal by design. */
export function die(msg: string): never {
	console.error(`error: ${msg}`);
	process.exit(1);
}

/** fetch() that refuses to return a non-2xx response. */
export async function get(url: string): Promise<Response> {
	const res = await fetch(url);
	if (!res.ok) die(`GET ${url} -> ${res.status} ${res.statusText}`);
	return res;
}

export function sha256(bytes: Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

export function humanMiB(bytes: number): string {
	return `${(bytes / 1048576).toFixed(1)} MiB`;
}

// A reader for the one thing this page needs from a zip: the files inside it.
//
// The browser can already inflate - DecompressionStream('deflate-raw') - so all
// that is missing is the container, and that is a few hundred bytes of header
// parsing. Pulling in a library for it would be a dependency for no reason.
//
// Only the two methods that matter are handled: stored and deflated. Anything
// else is reported rather than guessed at.

const EOCD = 0x06054b50;
const EOCD64_LOCATOR = 0x07064b50;
const EOCD64 = 0x06064b50;
const CENTRAL = 0x02014b50;

function findEOCD(view) {
	// The end record is last, but a comment can follow it, so scan back from
	// the end over the largest comment the format allows.
	const min = Math.max(0, view.byteLength - 0xffff - 22);
	for (let i = view.byteLength - 22; i >= min; i--) {
		if (view.getUint32(i, true) === EOCD) return i;
	}
	return -1;
}

async function inflateRaw(bytes) {
	const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Read a zip and return its files, newest format details ignored: no
 * encryption, no multi-part archives.
 *
 * @param {ArrayBuffer|Uint8Array} data
 * @returns {Promise<Array<{name: string, bytes: Uint8Array}>>}
 */
export async function readZip(data) {
	const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

	const eocd = findEOCD(view);
	if (eocd < 0) throw new Error('zip ファイルではないようです');

	let count = view.getUint16(eocd + 10, true);
	let dirOffset = view.getUint32(eocd + 16, true);

	// Zip64, for the fields that would otherwise be all ones.
	if (dirOffset === 0xffffffff || count === 0xffff) {
		const loc = eocd - 20;
		if (loc >= 0 && view.getUint32(loc, true) === EOCD64_LOCATOR) {
			const rec = Number(view.getBigUint64(loc + 8, true));
			if (view.getUint32(rec, true) === EOCD64) {
				count = Number(view.getBigUint64(rec + 32, true));
				dirOffset = Number(view.getBigUint64(rec + 48, true));
			}
		}
	}

	const out = [];
	let p = dirOffset;
	for (let i = 0; i < count; i++) {
		if (view.getUint32(p, true) !== CENTRAL) break;
		const method = view.getUint16(p + 10, true);
		const compressed = view.getUint32(p + 20, true);
		const nameLen = view.getUint16(p + 28, true);
		const extraLen = view.getUint16(p + 30, true);
		const commentLen = view.getUint16(p + 32, true);
		const localOffset = view.getUint32(p + 42, true);
		const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen));
		p += 46 + nameLen + extraLen + commentLen;

		// Directory entries carry no data.
		if (name.endsWith('/')) continue;

		// The local header repeats the name and extra fields, at its own
		// lengths, and the data starts after them.
		const lNameLen = view.getUint16(localOffset + 26, true);
		const lExtraLen = view.getUint16(localOffset + 28, true);
		const start = localOffset + 30 + lNameLen + lExtraLen;
		const raw = buf.subarray(start, start + compressed);

		if (method === 0) out.push({ name, bytes: raw.slice() });
		else if (method === 8) out.push({ name, bytes: await inflateRaw(raw) });
		else throw new Error(`${name}: 未対応の圧縮方式です (method ${method})`);
	}
	return out;
}

// Turns a JW_CAD plot into SVG.
//
// The stream comes from web/wasm.jwp, the plotter definition this page installs
// into C:\JWCAD: one command per line, the character code last. See
// test/plot-rectangle.txt for a real one.
//
//   B minx miny maxx maxy paper   the drawing's extents
//   W n                           pen 1-6
//   Y n                           line type 1-8
//   M x y                         move
//   D x y                         draw to
//   C cx cy r a1 a2               arc
//   P x y                         point
//   A x y sx sy ang <char>        single-byte text
//   N x y sx sy ang <char>        half-width katakana
//   K x y sx sy ang <two bytes>   double-byte text
//   E minx miny maxx maxy         end
//
// Coordinates are in hundredths of a millimetre (unit_x/unit_y in the
// definition), and the plotter's Y axis points up while SVG's points down.
//
// The stream is handed in decoded as latin1, which is to say not decoded at
// all: every character is one byte of the original. Text has to stay as bytes
// because PDF wants the Shift-JIS as it came, while SVG wants it as characters,
// and a decode at read time would throw the bytes away.

const UNITS_PER_MM = 100;

// JW_CAD numbers its pens 1-6 and leaves the colours to the plotter. These are
// the screen colours it uses for the same numbers, so a print looks like what
// was on screen.
const PEN_COLOURS = ['#000000', '#0000c0', '#c00000', '#00a000', '#00a0a0', '#c000c0', '#a06000'];

// Line types 2-8 are the broken ones. The pitches are in millimetres, scaled
// into plot units when written out.
const DASHES = {
	2: [3, 1.5],
	3: [6, 1.5],
	4: [6, 1.5, 1.5, 1.5],
	5: [12, 3],
	6: [12, 3, 3, 3],
	7: [24, 6],
	8: [24, 6, 6, 6],
};

/** The bytes a latin1 string stands for. */
export function bytesOf(latin1) {
	return Uint8Array.from(latin1, (c) => c.charCodeAt(0) & 0xff);
}

/** Those bytes read as Shift-JIS, which is what the plot carries. */
export function decodeSjis(latin1) {
	return new TextDecoder('shift_jis').decode(bytesOf(latin1));
}

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * Read the stream into shapes. Everything downstream - SVG, PDF - works from
 * this, so the stream is only ever understood in one place.
 *
 * @param {string} text  the plot stream, already decoded from Shift-JIS
 * @returns {{bounds: object, paths: Array, arcs: Array, points: Array, runs: Array, glyphs: number}}
 */
export function parsePlot(text) {
	let bounds = null;
	let pen = 1;
	let type = 1;
	let cursor = null;
	let run = null;          // the polyline being built
	const paths = [];
	const arcs = [];
	const points = [];
	const texts = [];

	const closeRun = () => {
		if (run && run.pts.length > 1) paths.push(run);
		run = null;
	};

	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trimEnd();
		if (!line) continue;
		const cmd = line[0];
		// Everything after the command letter; the character codes in A/N/K are
		// the last field and may be any byte, so split off only what is needed.
		const rest = line.slice(1).trimStart();
		const n = (s) => Number.parseFloat(s);

		if (cmd === 'B' || cmd === 'E') {
			const f = rest.split(/\s+/);
			if (!bounds && f.length >= 4) {
				bounds = { minX: n(f[0]), minY: n(f[1]), maxX: n(f[2]), maxY: n(f[3]), paper: f[4] || '' };
			}
			if (cmd === 'E') closeRun();
		} else if (cmd === 'W') {
			const p = Number.parseInt(rest, 10);
			if (p !== pen) { closeRun(); pen = p; }
		} else if (cmd === 'Y') {
			// Emitted before nearly every primitive, usually unchanged.
			const t = Number.parseInt(rest, 10);
			if (t !== type) { closeRun(); type = t; }
		} else if (cmd === 'M') {
			closeRun();
			const [x, y] = rest.split(/\s+/).map(n);
			cursor = [x, y];
		} else if (cmd === 'D') {
			const [x, y] = rest.split(/\s+/).map(n);
			if (!run) {
				if (!cursor) cursor = [x, y];
				run = { pen, type, pts: [cursor] };
			}
			run.pts.push([x, y]);
			cursor = [x, y];
		} else if (cmd === 'C') {
			closeRun();
			const [cx, cy, r, a1, a2] = rest.split(/\s+/).map(n);
			arcs.push({ pen, type, cx, cy, r, a1, a2 });
			cursor = null;
		} else if (cmd === 'P') {
			const [x, y] = rest.split(/\s+/).map(n);
			points.push({ pen, x, y });
		} else if (cmd === 'A' || cmd === 'N' || cmd === 'K') {
			// x y size_x size_y angle <char...> - the character is the remainder,
			// so take five numbers off the front and keep the rest verbatim.
			const m = rest.match(/^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s?(.*)$/);
			if (!m) continue;
			const [, x, y, sx, sy, ang, ch] = m;
			if (!ch) continue;
			texts.push({ pen, x: n(x), y: n(y), sx: n(sx), sy: n(sy), ang: n(ang), ch });
		}
	}
	closeRun();

	if (!bounds) bounds = { minX: 0, minY: 0, maxX: 42050, maxY: 29700, paper: '' };

	// One character at a time is what the plotter emits; join the ones that sit
	// on the same baseline at the same size, so the PDF carries words rather
	// than a scatter of letters.
	const runs = [];
	for (const t of texts) {
		const last = runs[runs.length - 1];
		const sameLine = last
			&& last.pen === t.pen && last.sx === t.sx && last.sy === t.sy && last.ang === t.ang
			&& Math.abs(t.y - last.y) < 1
			&& t.x >= last.endX - t.sx * 0.35 && t.x <= last.endX + t.sx * 1.2;
		if (sameLine) { last.ch += t.ch; last.endX = t.x + t.sx; }
		else runs.push({ ...t, endX: t.x + t.sx });
	}

	return { bounds, paths, arcs, points, runs, glyphs: texts.length };
}

export const UNITS = UNITS_PER_MM;
export const PENS = PEN_COLOURS;
export const DASH_PATTERNS = DASHES;

/**
 * @param {string} text  the plot stream, already decoded from Shift-JIS
 * @returns {{svg: string, lines: number, glyphs: number}}
 */
export function plotToSvg(text) {
	const { bounds, paths, arcs, points, runs, glyphs } = parsePlot(text);
	const w = bounds.maxX - bounds.minX;
	const h = bounds.maxY - bounds.minY;

	const out = [];
	const stroke = (o) => {
		const dash = DASHES[o.type];
		return `stroke="${PEN_COLOURS[o.pen] || PEN_COLOURS[0]}"` +
			(dash ? ` stroke-dasharray="${dash.map((d) => d * UNITS_PER_MM).join(' ')}"` : '');
	};

	out.push('<?xml version="1.0" encoding="UTF-8"?>');
	out.push(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${(w / UNITS_PER_MM).toFixed(2)}mm"` +
		` height="${(h / UNITS_PER_MM).toFixed(2)}mm" viewBox="${bounds.minX} ${-bounds.maxY} ${w} ${h}">`
	);
	out.push(`<rect x="${bounds.minX}" y="${-bounds.maxY}" width="${w}" height="${h}" fill="#fff"/>`);
	// The plotter's Y points up; flip once for everything.
	out.push('<g transform="scale(1,-1)" fill="none" stroke-width="20" stroke-linecap="round" stroke-linejoin="round">');

	for (const p of paths) {
		out.push(`<polyline ${stroke(p)} points="${p.pts.map(([x, y]) => `${x},${y}`).join(' ')}"/>`);
	}
	for (const a of arcs) {
		// A full turn cannot be drawn as one SVG arc, so circles go out as one.
		const sweep = Math.abs(a.a2 - a.a1);
		if (sweep >= 359.9) {
			out.push(`<circle ${stroke(a)} cx="${a.cx}" cy="${a.cy}" r="${a.r}"/>`);
			continue;
		}
		const rad = (d) => (d * Math.PI) / 180;
		const x1 = a.cx + a.r * Math.cos(rad(a.a1)), y1 = a.cy + a.r * Math.sin(rad(a.a1));
		const x2 = a.cx + a.r * Math.cos(rad(a.a2)), y2 = a.cy + a.r * Math.sin(rad(a.a2));
		const large = sweep > 180 ? 1 : 0;
		const ccw = a.a2 > a.a1 ? 1 : 0;
		out.push(`<path ${stroke(a)} d="M ${x1} ${y1} A ${a.r} ${a.r} 0 ${large} ${ccw} ${x2} ${y2}"/>`);
	}
	for (const p of points) {
		out.push(`<circle fill="${PEN_COLOURS[p.pen] || PEN_COLOURS[0]}" stroke="none" cx="${p.x}" cy="${p.y}" r="30"/>`);
	}

	if (runs.length) {
		// Text is flipped back the right way up, one group per run.
		out.push('</g>');
		out.push('<g stroke="none">');
		for (const t of runs) {
			const fill = PEN_COLOURS[t.pen] || PEN_COLOURS[0];
			// Place at the baseline, then undo the Y flip around that point.
			const tf = `translate(${t.x} ${-t.y}) scale(1,1)` + (t.ang ? ` rotate(${-t.ang})` : '');
			out.push(
				`<text transform="${tf}" fill="${fill}" font-size="${t.sy}"` +
				` font-family="sans-serif" textLength="${Math.max(t.endX - t.x, t.sx)}"` +
				` lengthAdjust="spacingAndGlyphs">${esc(decodeSjis(t.ch))}</text>`
			);
		}
	}
	out.push('</g>');
	out.push('</svg>');

	return {
		svg: out.join('\n'),
		lines: paths.reduce((a, p) => a + p.pts.length - 1, 0),
		glyphs,
	};
}

/**
 * Write the plot as a PDF, through libharu compiled to wasm (web/pdf.js).
 *
 * Text goes in as the Shift-JIS bytes the plot carried, against PDF's standard
 * 90ms-RKSJ-H encoding, so it stays real text without a font being embedded.
 *
 * @param {string} text  the plot stream, decoded as latin1
 * @param {object} mod   the instantiated pdf.wasm module
 * @returns {{pdf: Uint8Array, lines: number, glyphs: number}}
 */
export function plotToPdf(text, mod) {
	const { bounds, paths, arcs, points, runs, glyphs } = parsePlot(text);
	const mm = (v) => v / UNITS_PER_MM;
	const w = bounds.maxX - bounds.minX;
	const h = bounds.maxY - bounds.minY;

	// The page's origin sits at the drawing's lower left corner.
	const px = (x) => mm(x - bounds.minX);
	const py = (y) => mm(y - bounds.minY);

	const rgb = (pen) => {
		const hex = PEN_COLOURS[pen] || PEN_COLOURS[0];
		return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
	};

	if (mod._pdf_begin(mm(w), mm(h)) !== 0) throw new Error('PDF を開始できませんでした');
	try {
		mod._pdf_width(0.2);
		for (const p of paths) {
			mod._pdf_color(...rgb(p.pen));
			const d = DASHES[p.type];
			mod._pdf_dash(d ? d[0] : 0, d ? d[1] : 0);
			mod._pdf_move(px(p.pts[0][0]), py(p.pts[0][1]));
			for (let i = 1; i < p.pts.length; i++) mod._pdf_line(px(p.pts[i][0]), py(p.pts[i][1]));
			mod._pdf_stroke();
		}
		for (const a of arcs) {
			mod._pdf_color(...rgb(a.pen));
			const d = DASHES[a.type];
			mod._pdf_dash(d ? d[0] : 0, d ? d[1] : 0);
			mod._pdf_arc(px(a.cx), py(a.cy), mm(a.r), a.a1, a.a2);
		}
		mod._pdf_dash(0, 0);
		for (const p of points) {
			mod._pdf_color(...rgb(p.pen));
			mod._pdf_dot(px(p.x), py(p.y), 0.3);
		}
		for (const t of runs) {
			mod._pdf_color(...rgb(t.pen));
			// The bytes, with a terminator, straight into the module's memory.
			const bytes = bytesOf(t.ch);
			const ptr = mod._malloc(bytes.length + 1);
			try {
				mod.HEAPU8.set(bytes, ptr);
				mod.HEAPU8[ptr + bytes.length] = 0;
				mod._pdf_text(px(t.x), py(t.y), mm(t.sy), t.ang, ptr);
			} finally {
				mod._free(ptr);
			}
		}

		const len = mod._pdf_end();
		if (len <= 0) throw new Error('PDF を書き出せませんでした');
		const at = mod._pdf_data();
		const pdf = mod.HEAPU8.slice(at, at + len);
		return { pdf, lines: paths.reduce((a, p) => a + p.pts.length - 1, 0), glyphs };
	} finally {
		mod._pdf_release();
	}
}

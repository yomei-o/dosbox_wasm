// Boots DOSBox-X (wasm) with JW_CAD for DOS/V, and wires up the file panel.
//
// Layout inside the emulator:
//   C:  ->  /work   IDBFS, so drawings and JW_CAD's own settings survive a reload
//       C:\JWCAD    the distribution, unpacked from third_party/jwcv222h.lzh
//
// The JW_CAD archive is shipped and unpacked as-is rather than pre-extracted,
// because its licence asks that the required file set travel together
// unmodified.

import createLzh from './lzh.js';
import { plotToSvg, plotToPdf, describe } from './plot.js';
import createPdf from './pdf.js';

const JWCAD_LZH = '../third_party/jwcv222h.lzh';
const PLOT_JWP = './wasm.jwp';

const WORK = '/work';
const JWCAD_DIR = WORK + '/JWCAD';
const STAMP = WORK + '/INSTALL.VER';
// Where the printer port is captured. It sits on C: so the file panel
// shows it, and the page can pick it up and convert it.
const PLOT_OUT = WORK + '/PLOT.PRN';
// Bump when the contents of third_party/ change, to reinstall over an old C:.
const INSTALL_VERSION = 'jwcv222h+plot-1';

const $ = (id) => document.getElementById(id);
const statusEl = $('status');

// ?trace=1 mirrors DOSBox-X's log to the web server's access log through a
// synchronous XHR. Console logging is useless when the emulator wedges the
// main thread, because a blocked renderer never delivers the messages; a sync
// XHR still goes out. See tools/README.md.
const TRACE = new URLSearchParams(location.search).has('trace');
function trace(s) {
	if (!TRACE) return;
	try {
		const x = new XMLHttpRequest();
		x.open('GET', '/LOG/' + encodeURIComponent(String(s)).slice(0, 300), false);
		x.send(null);
	} catch { /* the trace is best effort */ }
}

// SDL2's Emscripten backend listens for keys on the window, so a keystroke
// meant for the Japanese input would also reach DOS and fire a JW_CAD command.
// This runs at module scope, before dosbox-x.js is appended and therefore
// before SDL's listener, and stops those events dead.
//
// Stopping them at the window also means the focused field never sees its own
// listeners, so every key this page acts on is decided here.
function inFormField() {
	const el = document.activeElement;
	return el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA');
}

for (const type of ['keydown', 'keyup', 'keypress']) {
	window.addEventListener(type, (ev) => {
		const composing = ev.isComposing || ev.keyCode === 229;

		// Ctrl+Space reaches the on-screen input from either side: it opens it,
		// or takes focus back to it when it is open but the canvas has focus -
		// which is where a click to place the next label leaves it.
		if (type === 'keydown' && ev.ctrlKey && ev.code === 'Space' && !composing) {
			ev.preventDefault();
			ev.stopImmediatePropagation();
			if ($('ime-overlay').hidden) imeOpen();
			else if (document.activeElement.id !== 'ime') $('ime').focus();
			else imeClose();
			return;
		}

		if (!inFormField()) return;

		if (type === 'keydown' && document.activeElement.id === 'ime' && !composing) {
			if (ev.key === 'Enter') {
				ev.preventDefault();
				imeSend();
			} else if (ev.key === 'Escape') {
				ev.preventDefault();
				imeClose();
			} else if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
				// Drawings repeat their labels, so let the last few come back.
				ev.preventDefault();
				imeRecall(ev.key === 'ArrowUp' ? 1 : -1);
			}
		}

		ev.stopImmediatePropagation();
	}, true);
}

function setStatus(text, isError) {
	statusEl.textContent = text;
	statusEl.classList.toggle('err', !!isError);
}

// --------------------------------------------------------------- archives

let lzhModule = null;

async function lzh() {
	if (lzhModule === null) lzhModule = await createLzh();
	return lzhModule;
}

/** Unpack an LZH held in memory. Returns [{name, data, isDir}]. */
async function unpack(bytes) {
	const M = await lzh();
	const inPtr = M._lzh_alloc(bytes.length);
	M.HEAPU8.set(bytes, inPtr);
	const lenPtr = M._lzh_alloc(4);
	const blobPtr = M._lzh_extract(inPtr, bytes.length, lenPtr);
	if (!blobPtr) {
		M._lzh_free(inPtr);
		M._lzh_free(lenPtr);
		throw new Error('LZH を展開できませんでした');
	}
	const blobLen = M.HEAPU32[lenPtr >> 2];
	const blob = M.HEAPU8.slice(blobPtr, blobPtr + blobLen);
	M._lzh_free(blobPtr);
	M._lzh_free(inPtr);
	M._lzh_free(lenPtr);

	const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
	const count = dv.getUint32(0, true);
	const sjis = new TextDecoder('shift_jis');
	const out = [];
	for (let i = 0; i < count; i++) {
		const o = 4 + i * 20;
		const nameOff = dv.getUint32(o, true);
		const nameLen = dv.getUint32(o + 4, true);
		const dataOff = dv.getUint32(o + 8, true);
		const dataLen = dv.getUint32(o + 12, true);
		const isDir = dv.getUint32(o + 16, true) !== 0;
		out.push({
			name: sjis.decode(blob.subarray(nameOff, nameOff + nameLen)).replace(/\\/g, '/'),
			data: blob.subarray(dataOff, dataOff + dataLen),
			isDir,
		});
	}
	return out;
}

async function fetchArchive(url) {
	const r = await fetch(url);
	if (!r.ok) throw new Error(url + ': ' + r.status);
	return new Uint8Array(await r.arrayBuffer());
}

// --------------------------------------------------------------- emulator

let Module = null;
let FS = null;

function mkdirp(path) {
	const parts = path.split('/').filter(Boolean);
	let cur = '';
	for (const p of parts) {
		cur += '/' + p;
		try { FS.mkdir(cur); } catch { /* exists */ }
	}
}

function writeFiles(dir, files) {
	mkdirp(dir);
	for (const f of files) {
		// DOS is case-insensitive but the emulated filesystem is not; the
		// archives are already upper case, so just normalise.
		const name = f.name.toUpperCase();
		if (f.isDir) { mkdirp(dir + '/' + name); continue; }
		const slash = name.lastIndexOf('/');
		if (slash > 0) mkdirp(dir + '/' + name.slice(0, slash));
		FS.writeFile(dir + '/' + name, f.data);
	}
}

function exists(path) {
	try { FS.stat(path); return true; } catch { return false; }
}

function buildConf(videoMode) {
	return `# generated by jwcad.js
[sdl]
# No capture. DOSBox-X hands the guest an absolute position whenever the mouse
# is not locked - (motion->x - clip.x) / (clip.w - 1) - so the cursor can track
# the pointer without pointer lock, and the page stays reachable. Capturing
# instead traps the pointer inside the canvas, which puts the Japanese input
# field out of reach.
autolock=false
output=surface
# The window matches the guest screen; the page scales the canvas with CSS.
windowresolution=original
# DOSBox-X's own menu bar sits exactly on top of JW_CAD's, and reacts to hover.
showmenu=false

[dosbox]
machine=svga_s3
memsize=16
title=JW_CAD
# Never let SDL scale the canvas by the display's device pixel ratio. It makes
# the window much larger than the guest screen, and DOSBox-X then centres the
# picture inside it at 1:1 - so the drawing looks small and every click lands
# off by the offset of the clip rectangle.
dpi aware=false

[dosv]
dosv=jp
fepcontrol=both

[cpu]
core=normal
cputype=pentium
cycles=fixed 30000

[render]
scaler=none
aspect=false

[dos]
hard drive data rate limit=0
floppy drive data rate limit=0

[keyboard]
auxdevice=intellimouse

# JW_CAD sends a plot to the printer port. Catch it in a file instead: the
# timeout closes the file after a quiet spell, which is the signal that the
# plot has finished.
[parallel]
parallel1=file file:${PLOT_OUT} timeout:2000

[autoexec]
@echo off
mount c ${WORK}
c:
cd \\JWCAD
JW_CADV.EXE ${videoMode}
`;
}

/**
 * Install everything the emulator needs into the (already mounted) IDBFS.
 * Returns true if anything was written.
 */
async function install() {
	let dirty = false;

	const stamp = exists(STAMP) ? new TextDecoder().decode(FS.readFile(STAMP)) : '';
	if (stamp !== INSTALL_VERSION) {
		setStatus('JW_CAD を展開しています…');
		const jw = await unpack(await fetchArchive(JWCAD_LZH));
		writeFiles(JWCAD_DIR, jw);
		// Our own plotter definition, so a plot comes out as something the page
		// can turn into SVG or PDF.
		const jwp = await fetch(PLOT_JWP);
		if (jwp.ok) FS.writeFile(JWCAD_DIR + '/WASM.JWP', new Uint8Array(await jwp.arrayBuffer()));
		FS.writeFile(STAMP, INSTALL_VERSION);
		dirty = true;
	}

	return dirty;
}

function syncfs(populate) {
	return new Promise((resolve, reject) => {
		FS.syncfs(populate, (err) => (err ? reject(err) : resolve()));
	});
}


function boot() {
	const videoMode = $('vmode').value;
	const canvas = $('canvas');

	Module = {
		canvas,
		arguments: ['-conf', '/dosbox-x.conf'],
		noInitialRun: false,
		print: (t) => { console.log(t); trace('out|' + t); },
		printErr: (t) => { console.warn(t); trace('err|' + t); },
		preRun: [function () {
			FS = Module.FS;
			Module.addRunDependency('jwcad-install');
			(async () => {
				try {
					FS.mkdir(WORK);
					FS.mount(Module.IDBFS, {}, WORK);
					await syncfs(true);
					const dirty = await install();
					if (dirty) await syncfs(false);
					FS.writeFile('/dosbox-x.conf', buildConf(videoMode));
					refreshFiles();
					setStatus('起動中…');
				} catch (e) {
					setStatus('起動に失敗しました: ' + e.message, true);
					console.error(e);
				} finally {
					Module.removeRunDependency('jwcad-install');
				}
			})();
		}],
		onAbort: (w) => { trace('ABORT|' + w); setStatus('異常終了しました: ' + w, true); },
		onRuntimeInitialized: () => {
			canvas.focus();
			setStatus('実行中 — 日本語は Ctrl+Space（画面上に入力欄が開きます）');
		},
	};
	window.Module = Module;

	canvas.addEventListener('pointerdown', () => canvas.focus());

	// JW_CAD uses the right button constantly - it is half of its two-button
	// idiom - so the browser context menu has to stay out of the way. Also stop
	// the middle button from starting an autoscroll, and kill selection
	// drags, both of which interrupt a drag in the drawing.
	canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
	canvas.addEventListener('auxclick', (ev) => ev.preventDefault());
	canvas.addEventListener('dragstart', (ev) => ev.preventDefault());
	canvas.addEventListener('selectstart', (ev) => ev.preventDefault());


	const s = document.createElement('script');
	s.src = 'dosbox-x.js';
	s.onerror = () => setStatus('dosbox-x.js を読み込めませんでした', true);
	document.body.appendChild(s);
}

// -------------------------------------------------------- Japanese input
//
// DOSBox-X already knows how to deliver text typed with a host IME: it encodes
// the text to the guest code page and pushes the bytes into the BIOS keyboard
// buffer, which is exactly what a DOS FEP does when you confirm a conversion.
// That handler is compiled out for Emscripten, so scripts/patch-dosbox-x.py
// exposes its last step as dosbox_x_type_bytes and the text field drives it.
// The browser's own IME does the conversion, so no DOS FEP is involved.

let sjisTable = null;

/** Invert the browser's own Shift_JIS table rather than shipping one. */
function buildSjisTable() {
	const dec = new TextDecoder('shift_jis');
	const map = new Map();
	const one = new Uint8Array(1);
	for (let b = 0x20; b <= 0xff; b++) {
		if ((b >= 0x81 && b <= 0x9f) || (b >= 0xe0 && b <= 0xfc)) continue;
		one[0] = b;
		const ch = dec.decode(one);
		if (ch.length === 1 && ch !== '\ufffd' && !map.has(ch)) map.set(ch, [b]);
	}
	const two = new Uint8Array(2);
	for (const [from, to] of [[0x81, 0x9f], [0xe0, 0xfc]]) {
		for (let b1 = from; b1 <= to; b1++) {
			for (let b2 = 0x40; b2 <= 0xfc; b2++) {
				if (b2 === 0x7f) continue;
				two[0] = b1;
				two[1] = b2;
				const ch = dec.decode(two);
				if (ch.length === 1 && ch !== '\ufffd' && !map.has(ch)) map.set(ch, [b1, b2]);
			}
		}
	}
	return map;
}

function toSjis(text) {
	if (!sjisTable) sjisTable = buildSjisTable();
	const bytes = [];
	const dropped = [];
	for (const ch of text) {
		const b = sjisTable.get(ch);
		if (b) bytes.push(...b);
		else dropped.push(ch);
	}
	return { bytes: Uint8Array.from(bytes), dropped };
}

// The BIOS keyboard buffer holds only a handful of entries, so the text is
// dripped in and whatever the guest has not taken yet stays queued.
let typePending = new Uint8Array(0);
let typeTimer = null;

function typeFn() {
	return (Module && Module._dosbox_x_type_bytes) || window._dosbox_x_type_bytes || null;
}

function flushTyping() {
	const fn = typeFn();
	if (!fn || typePending.length === 0) {
		clearInterval(typeTimer);
		typeTimer = null;
		return;
	}
	const chunk = typePending.subarray(0, Math.min(8, typePending.length));
	const ptr = window._malloc(chunk.length);
	Module.HEAPU8.set(chunk, ptr);
	const accepted = fn(ptr, chunk.length);
	window._free(ptr);
	if (accepted > 0) typePending = typePending.slice(accepted);
}

function typeText(text) {
	if (!typeFn()) {
		note('この dosbox-x.wasm には文字入力の口がありません（再ビルドが必要です）', true);
		return;
	}
	const { bytes, dropped } = toSjis(text);
	const merged = new Uint8Array(typePending.length + bytes.length);
	merged.set(typePending);
	merged.set(bytes, typePending.length);
	typePending = merged;
	if (!typeTimer) typeTimer = setInterval(flushTyping, 40);
	if (dropped.length) {
		note('Shift_JIS にない文字は送れませんでした: ' + dropped.join(''), true);
	} else {
		note('');
	}
}

// ------------------------------------------------------------- file panel

let cwd = WORK;

function fmtSize(n) {
	if (n < 1024) return n + ' B';
	if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
	return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function dosPath(p) {
	return 'C:' + p.slice(WORK.length).replace(/\//g, '\\') + '\\';
}

function refreshFiles() {
	const table = $('fs-table');
	table.innerHTML = '';
	if (!FS) return;
	$('fs-path').textContent = dosPath(cwd);
	$('fs-up').disabled = cwd === WORK;

	let names;
	try { names = FS.readdir(cwd); } catch { return; }
	const rows = [];
	for (const name of names) {
		if (name === '.' || name === '..') continue;
		const full = cwd + '/' + name;
		let st;
		try { st = FS.stat(full); } catch { continue; }
		rows.push({ name, full, dir: FS.isDir(st.mode), size: st.size });
	}
	rows.sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name)));

	for (const r of rows) {
		const tr = document.createElement('tr');

		const tdName = document.createElement('td');
		tdName.className = 'name';
		if (r.dir) {
			const a = document.createElement('a');
			a.textContent = r.name + '\\';
			a.onclick = () => { cwd = r.full; refreshFiles(); };
			tdName.appendChild(a);
		} else {
			tdName.textContent = r.name;
		}
		tr.appendChild(tdName);

		const tdSize = document.createElement('td');
		tdSize.className = 'size';
		tdSize.textContent = r.dir ? '' : fmtSize(r.size);
		tr.appendChild(tdSize);

		const tdAct = document.createElement('td');
		tdAct.className = 'actions';
		if (!r.dir) {
			const dl = document.createElement('button');
			dl.textContent = '取り出す';
			dl.onclick = () => download(r.full, r.name);
			tdAct.appendChild(dl);
		}
		const del = document.createElement('button');
		del.textContent = '削除';
		del.onclick = () => remove(r.full, r.dir, r.name);
		tdAct.appendChild(del);
		tr.appendChild(tdAct);

		table.appendChild(tr);
	}
}

function download(path, name) {
	const data = FS.readFile(path);
	const blob = new Blob([data], { type: 'application/octet-stream' });
	const a = document.createElement('a');
	a.href = URL.createObjectURL(blob);
	a.download = name;
	a.click();
	setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function remove(path, isDir, name) {
	if (!confirm(name + ' を削除しますか？')) return;
	try {
		if (isDir) FS.rmdir(path);
		else FS.unlink(path);
	} catch (e) {
		note('削除できませんでした: ' + e.message, true);
		return;
	}
	await persist();
	refreshFiles();
}

function note(text, isError) {
	const el = $('fs-note');
	el.textContent = text;
	el.classList.toggle('err', !!isError);
}

async function persist() {
	if (!FS) return;
	try {
		await syncfs(false);
	} catch (e) {
		note('保存に失敗しました: ' + e.message, true);
	}
}

// ----------------------------------------------------------------- wiring

$('fs-up').onclick = () => {
	if (cwd === WORK) return;
	cwd = cwd.slice(0, cwd.lastIndexOf('/')) || WORK;
	refreshFiles();
};

$('fs-add').onclick = () => $('fs-file').click();

$('fs-file').onchange = async (ev) => {
	const files = [...ev.target.files];
	ev.target.value = '';
	if (!FS) return;
	for (const f of files) {
		const bytes = new Uint8Array(await f.arrayBuffer());
		// DOS only sees 8.3 names; keep it predictable and upper case.
		FS.writeFile(cwd + '/' + f.name.toUpperCase(), bytes);
	}
	await persist();
	refreshFiles();
	note(files.length + ' 個のファイルを入れました。JW_CAD から見えます。');
};

$('fs-mkdir').onclick = async () => {
	const name = prompt('フォルダ名（8文字まで）');
	if (!name) return;
	try { FS.mkdir(cwd + '/' + name.toUpperCase()); } catch (e) {
		note('作成できませんでした: ' + e.message, true);
		return;
	}
	await persist();
	refreshFiles();
};

// Placing text in a drawing happens over and over, so the input sits on the
// emulator screen and is reached with a key. Going to a field elsewhere on the
// page with the mouse for every label is not usable.
const imeHistory = [];
let imeHistAt = -1;

function imeOpen() {
	const box = $('ime-overlay');
	box.hidden = false;
	const el = $('ime');
	el.value = '';
	imeHistAt = -1;
	el.focus();
}

// Sending does not close it. A label needs a position clicked on the canvas
// first, and that click takes focus off the field anyway, so leaving the field
// on screen keeps the loop to click, Ctrl+Space, type, Enter - and keeps what
// was sent last in view.
function imeSend() {
	const el = $('ime');
	const text = el.value;
	el.value = '';
	imeHistAt = -1;
	if (!text) return;
	if (imeHistory[0] !== text) imeHistory.unshift(text);
	imeHistory.length = Math.min(imeHistory.length, 20);
	const last = $('ime-last');
	last.hidden = false;
	last.innerHTML = '直前: <b></b>';
	last.querySelector('b').textContent = text;
	$('canvas').focus();
	typeText(text);
}

function imeClose() {
	const el = $('ime');
	el.value = '';
	imeHistAt = -1;
	$('ime-overlay').hidden = true;
	$('canvas').focus();
}

function imeRecall(dir) {
	if (!imeHistory.length) return;
	imeHistAt = Math.max(-1, Math.min(imeHistory.length - 1, imeHistAt + dir));
	const el = $('ime');
	el.value = imeHistAt < 0 ? '' : imeHistory[imeHistAt];
	el.setSelectionRange(el.value.length, el.value.length);
}

// A plot written by JW_CAD starts with the extents line our plotter definition
// emits, which is enough to pick it out from whatever else is on C:.
function findPlotFiles() {
	const out = [];
	for (const dir of [JWCAD_DIR, WORK]) {
		let names = [];
		try { names = FS.readdir(dir); } catch { continue; }
		for (const name of names) {
			if (name === '.' || name === '..') continue;
			const path = dir + '/' + name;
			let st;
			try { st = FS.stat(path); } catch { continue; }
			if (FS.isDir(st.mode) || st.size < 8 || st.size > 40 * 1024 * 1024) continue;
			let head;
			try { head = FS.readFile(path).subarray(0, 40); } catch { continue; }
			if (/^B\s+-?\d/.test(new TextDecoder('latin1').decode(head))) {
				out.push({ path, name, mtime: st.mtime ? +st.mtime : 0 });
			}
		}
	}
	return out.sort((a, b) => b.mtime - a.mtime);
}

// Read the newest plot and turn it into SVG, which everything else is built on.
function latestPlot() {
	if (!FS) { setStatus('起動を待ってください。', true); return null; }
	const found = findPlotFiles();
	if (!found.length) {
		setStatus('プロッタ出力が見つかりません。JW_CAD でプロッタ→ファイル出力してから押してください。', true);
		return null;
	}
	const pick = found[0];
	// latin1 keeps every byte as it is; the writers decode the text themselves,
	// because SVG wants characters and PDF wants the original Shift-JIS.
	const text = new TextDecoder('latin1').decode(FS.readFile(pick.path));
	return { text, name: pick.name.replace(/\.[^.]*$/, '') };
}

function offer(blob, filename) {
	const a = document.createElement('a');
	a.href = URL.createObjectURL(blob);
	a.download = filename;
	a.click();
	setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

$('plot2svg').onclick = () => {
	try {
		const r = latestPlot();
		if (!r) return;
		const { svg, lines, glyphs, seen } = plotToSvg(r.text);
		offer(new Blob([svg], { type: 'image/svg+xml' }), r.name + '.svg');
		setStatus(`${r.name} を SVG にしました（線 ${lines} 本、文字 ${glyphs} / 出力の中身 ${describe(seen)}）。`);
	} catch (e) {
		setStatus('変換できませんでした: ' + e.message, true);
		console.error(e);
	}
};

// The long edge, in pixels. Rasterising cost goes with the area, so a big
// sheet at a high setting takes a while; the default is a readable compromise.
const pngLongEdge = () => Number($('png-size').value) || 2400;

$('plot2png').onclick = async () => {
	try {
		const r = latestPlot();
		if (!r) return;
		setStatus('PNG を作っています…');
		const { svg, lines, glyphs, seen } = plotToSvg(r.text);
		const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
		try {
			const img = new Image();
			await new Promise((resolve, reject) => {
				img.onload = resolve;
				img.onerror = () => reject(new Error('SVG を読めませんでした'));
				img.src = url;
			});
			// The SVG carries its size in millimetres; scale off its aspect.
			const ratio = img.naturalWidth && img.naturalHeight
				? img.naturalWidth / img.naturalHeight : Math.SQRT2;
			const edge = pngLongEdge();
			const w = ratio >= 1 ? edge : Math.round(edge * ratio);
			const h = ratio >= 1 ? Math.round(edge / ratio) : edge;
			const c = document.createElement('canvas');
			c.width = w;
			c.height = h;
			const g = c.getContext('2d');
			g.fillStyle = '#fff';
			g.fillRect(0, 0, w, h);
			g.drawImage(img, 0, 0, w, h);
			const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
			if (!blob) throw new Error('PNG にできませんでした');
			offer(blob, r.name + '.png');
			setStatus(`${r.name} を PNG にしました（${w}×${h}、線 ${lines} 本、文字 ${glyphs} / 出力の中身 ${describe(seen)}）。`);
		} finally {
			URL.revokeObjectURL(url);
		}
	} catch (e) {
		setStatus('変換できませんでした: ' + e.message, true);
		console.error(e);
	}
};

let pdfModule = null;

$('plot2pdf').onclick = async () => {
	try {
		const r = latestPlot();
		if (!r) return;
		setStatus('PDF を作っています…');
		if (!pdfModule) pdfModule = await createPdf();
		const { pdf, lines, glyphs, seen } = plotToPdf(r.text, pdfModule);
		offer(new Blob([pdf], { type: 'application/pdf' }), r.name + '.pdf');
		setStatus(`${r.name} を PDF にしました（線 ${lines} 本、文字 ${glyphs} / 出力の中身 ${describe(seen)}）。`);
	} catch (e) {
		setStatus('変換できませんでした: ' + e.message, true);
		console.error(e);
	}
};

$('save').onclick = async () => {
	await persist();
	note('保存しました。');
};

$('restart').onclick = async () => {
	await persist();
	location.reload();
};

// JW_CAD writes its profile and drawings straight to C:; flush periodically so
// a closed tab does not lose them.
setInterval(() => { if (FS) persist(); }, 15000);
window.addEventListener('pagehide', () => { if (FS) FS.syncfs(false, () => {}); });

boot();

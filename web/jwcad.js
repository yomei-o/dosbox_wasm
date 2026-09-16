// Boots DOSBox-X (wasm) with JW_CAD for DOS/V, and wires up the file panel.
//
// Layout inside the emulator:
//   C:  ->  /work   IDBFS, so drawings and JW_CAD's own settings survive a reload
//       C:\JWCAD    the distribution, unpacked from third_party/jwcv222h.lzh
//       C:\WXP      the FEP, only present once the user supplies wxpj31.lzh
//
// The JW_CAD archive is shipped and unpacked as-is rather than pre-extracted,
// because its licence asks that the required file set travel together
// unmodified. That also means the same unpack path serves the FEP archives the
// user drops in.

import createLzh from './lzh.js';

const JWCAD_LZH = '../third_party/jwcv222h.lzh';
const WXPDOSV_LZH = '../third_party/wxpdosv4.lzh';

const WORK = '/work';
const JWCAD_DIR = WORK + '/JWCAD';
const WXP_DIR = WORK + '/WXP';
const STAMP = WORK + '/INSTALL.VER';
// Bump when the contents of third_party/ change, to reinstall over an old C:.
const INSTALL_VERSION = 'jwcv222h+wxpdosv4-1';

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

// SDL2's Emscripten backend listens for keys on the window, so anything typed
// into the Japanese input field would also reach DOS and fire JW_CAD commands.
// Registered here, at module scope, this runs before dosbox-x.js is appended
// and therefore before SDL's own listener, so it can stop the event dead.
for (const type of ['keydown', 'keyup', 'keypress']) {
	window.addEventListener(type, (ev) => {
		const el = document.activeElement;
		if (el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA')) {
			ev.stopImmediatePropagation();
		}
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

function fepInstalled() {
	return exists(WXP_DIR + '/WXP.SYS') && exists(WXP_DIR + '/WXPDOSV.EXE');
}

function buildConf(videoMode) {
	const fep = fepInstalled();
	const devices = fep
		? [
			'[devices]',
			// This section is DOSBox-X's CONFIG.SYS and runs before [autoexec],
			// so C: has to be mounted here or the DEVICE lines cannot find the
			// driver. RUN= is the section's own way to run a command.
			'RUN=MOUNT C ' + WORK,
			// /R resident, /Z compact, /H30 history, /CS  - the layout the
			// wxpdosv documentation uses.
			'DEVICE=C:\\WXP\\WXP.SYS /R /Z /H30 /CS /D1C:\\WXP\\JISHO01.DIC /D3C:\\WXP\\JISHO02.DIC',
			'DEVICE=C:\\WXP\\WXDP.SYS',
			'',
		].join('\n')
		: '';
	const mount = fep ? '' : 'mount c ' + WORK + '\n';
	// wxpdosv is deliberately not run. It exists to emulate J-3100 specific BIOS
	// calls for WXP on a DOS/V machine, but DOSBox-X's own DOS/V emulation
	// already covers that: WXP.SYS prints its banner and stays resident without
	// it (MEM /C goes from 32K to 158K), whereas with it the guest jumps to the
	// reset vector as soon as WXP has read its dictionary.

	return `# generated by jwcad.js
[sdl]
# No capture. DOSBox-X hands the guest an absolute position whenever the mouse
# is not locked - (motion->x - clip.x) / (clip.w - 1) - so the cursor can track
# the pointer without pointer lock, and the page stays reachable. Capturing
# instead traps the pointer inside the canvas, which puts the Japanese input
# field out of reach.
autolock=false
output=surface
# DOSBox-X's own menu bar sits exactly on top of JW_CAD's, and reacts to hover.
showmenu=false

[dosbox]
machine=svga_s3
memsize=16
title=JW_CAD

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

${devices}[autoexec]
@echo off
${mount}c:
cd \\JWCAD
JW_CADV.EXE ${videoMode}
`;
}

/**
 * Install everything the emulator needs into the (already mounted) IDBFS.
 * Returns true if anything was written.
 */
async function install(pendingArchives) {
	let dirty = false;

	const stamp = exists(STAMP) ? new TextDecoder().decode(FS.readFile(STAMP)) : '';
	if (stamp !== INSTALL_VERSION) {
		setStatus('JW_CAD を展開しています…');
		const jw = await unpack(await fetchArchive(JWCAD_LZH));
		writeFiles(JWCAD_DIR, jw);
		// wxpdosv on its own is harmless without WXP; stage it so that
		// dropping wxpj31.lzh is the only thing the user has to do.
		const dosv = await unpack(await fetchArchive(WXPDOSV_LZH));
		writeFiles(WXP_DIR, dosv);
		FS.writeFile(STAMP, INSTALL_VERSION);
		dirty = true;
	}

	for (const bytes of pendingArchives) {
		const files = await unpack(bytes);
		// WXP and wxpdosv both belong in C:\WXP.
		writeFiles(WXP_DIR, files);
		dirty = true;
	}

	return dirty;
}

function syncfs(populate) {
	return new Promise((resolve, reject) => {
		FS.syncfs(populate, (err) => (err ? reject(err) : resolve()));
	});
}

let pendingArchives = [];

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
					const dirty = await install(pendingArchives);
					pendingArchives = [];
					if (dirty) await syncfs(false);
					FS.writeFile('/dosbox-x.conf', buildConf(videoMode));
					updateFepState();
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
			setStatus('実行中 — 画面をクリックでマウスを掴み、Esc で解放。' +
				'日本語は上の欄へ（Ctrl+Shift+Space でいつでも戻れます）');
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

	// Clicking the screen hands the pointer to the emulator, and while it is
	// held there is no way to reach anything else on the page - including the
	// Japanese input field, which is the whole point of it. Esc is the
	// browser's own way out and cannot be suppressed; Ctrl+Shift+Space is a
	// second route that also puts the caret straight in the field.
	document.addEventListener('pointerlockchange', () => {
		const locked = document.pointerLockElement === canvas;
		$('locked').textContent = locked ? 'マウスを掴んでいます — Esc で解放' : '';
		if (!locked) $('ime').focus();
	});

	window.addEventListener('keydown', (ev) => {
		if (!ev.ctrlKey || !ev.shiftKey || ev.code !== 'Space') return;
		ev.preventDefault();
		if (document.pointerLockElement) document.exitPointerLock();
		$('ime').focus();
	}, true);

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

function updateFepState() {
	const el = $('fep-state');
	const on = FS && fepInstalled() && exists(WXP_DIR + '/JISHO01.DIC');
	el.textContent = on ? '導入済み' : '未導入';
	el.className = on ? 'on' : 'off';
	$('fep-key').disabled = !on;
	$('fep-trigger').disabled = !on;
}

/**
 * Send one key press to the emulator.
 *
 * SDL2's Emscripten backend listens on the window and reads `code`, `key` and
 * `keyCode` off the event; it does not care that the event is synthetic. Going
 * through here rather than asking the user to press the key means the browser
 * and the window manager cannot intercept it first, which they routinely do
 * with Alt.
 */
function sendKeys(combo) {
	$('canvas').focus();
	const mods = {
		altKey: combo.some((k) => k.key === 'Alt'),
		ctrlKey: combo.some((k) => k.key === 'Control'),
		shiftKey: combo.some((k) => k.key === 'Shift'),
	};
	const ev = (type, k, extra) => window.dispatchEvent(new KeyboardEvent(type, {
		code: k.code, key: k.key, keyCode: k.keyCode, which: k.keyCode, location: k.location,
		bubbles: true, cancelable: true, composed: true, ...extra,
	}));
	// Press in order, release in reverse, so a modifier is still held when the
	// key it modifies arrives.
	combo.forEach((k, i) => setTimeout(() => ev('keydown', k, mods), i * 30));
	const base = combo.length * 30 + 60;
	[...combo].reverse().forEach((k, i) => setTimeout(() => ev('keyup', k, {}), base + i * 30));
}

const KEYS = {
	AltRight: { code: 'AltRight', key: 'Alt', keyCode: 18, location: 2 },
	AltLeft: { code: 'AltLeft', key: 'Alt', keyCode: 18, location: 1 },
	ControlLeft: { code: 'ControlLeft', key: 'Control', keyCode: 17, location: 1 },
	ShiftLeft: { code: 'ShiftLeft', key: 'Shift', keyCode: 16, location: 1 },
	Backquote: { code: 'Backquote', key: '`', keyCode: 192, location: 0 },
	Space: { code: 'Space', key: ' ', keyCode: 32, location: 0 },
};

$('fep-key').onclick = () => {
	const combo = $('fep-trigger').value.split('+').map((n) => KEYS[n]).filter(Boolean);
	if (combo.length) sendKeys(combo);
};

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

$('fep-file').onchange = async (ev) => {
	const files = [...ev.target.files];
	ev.target.value = '';
	if (!files.length) return;
	try {
		for (const f of files) {
			const bytes = new Uint8Array(await f.arrayBuffer());
			if (FS) {
				writeFiles(WXP_DIR, await unpack(bytes));
			} else {
				pendingArchives.push(bytes);
			}
		}
	} catch (e) {
		setStatus('FEP の書庫を展開できませんでした: ' + e.message, true);
		return;
	}
	if (FS) {
		await persist();
		updateFepState();
		refreshFiles();
		setStatus('FEP を入れました。「再起動」で有効になります。');
	} else {
		setStatus('FEP を受け取りました。起動時に組み込みます。');
	}
};

$('ime').addEventListener('keydown', (ev) => {
	// While the IME is composing, Enter confirms the conversion - it must not
	// also mean "send", or the text goes before it has been converted.
	if (ev.key !== 'Enter' || ev.isComposing || ev.keyCode === 229) return;
	ev.preventDefault();
	const text = ev.target.value;
	if (!text) return;
	ev.target.value = '';
	typeText(text);
	$('canvas').focus();
});

$('ime-send').onclick = () => {
	const el = $('ime');
	if (!el.value) return;
	typeText(el.value);
	el.value = '';
	$('canvas').focus();
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

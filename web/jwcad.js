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
import { readZip } from './zip.js';

const JWCAD_LZH = '../third_party/jwcv222h.lzh';
const WXPDOSV_LZH = '../third_party/wxpdosv4.lzh';

const WORK = '/work';
const JWCAD_DIR = WORK + '/JWCAD';
const WXP_DIR = WORK + '/WXP';
// MS-DOS cannot be distributed, so the page takes the user's own disk images
// and assembles a boot floppy from them in place. Everything that would
// normally need host tools is done by the guest: DOSBox-X's DOS does the FAT
// work, and MS-DOS's own EXPAND.EXE undoes the SZDD compression on the disks.
const MSDOS_DIR = WORK + '/MSDOS';
const MSDOS_CFG = WORK + '/CFG';
// Spelled out, because these strings are full of DOS paths and an escaped
// backslash is easy to miscount.
const BS = String.fromCharCode(92);
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

function fepInstalled() {
	return exists(WXP_DIR + '/WXP.SYS') && exists(WXP_DIR + '/WXPDOSV.EXE');
}

function msdosInstalled() {
	return exists(MSDOS_DIR + '/DISK1.IMG') && exists(MSDOS_DIR + '/DISK3.IMG');
}

// What the guest runs before it boots, to turn the user's disk 1 into a boot
// floppy: strip what setup needs, expand the drivers off disks 1 and 3, write
// the two configuration files, and boot the result.
function prepBatch() {
	const del = [
		'SETUP.*', 'PACKING.LST', 'README.TXT', 'WINA20.38_', 'COUNTRY.SYS',
		'KEYBOARD.SYS', 'KEYB.COM', 'NLSFUNC.EXE', 'EMM386.EX_', 'HIMEM.SY_',
		'ANSI.SY_', 'SETVER.EX_', 'FDISK.*', 'FORMAT.COM', 'UNFORMAT.COM',
	].map((f) => 'DEL D:' + BS + f);
	const expand = [
		['D:' + BS + 'KKCFUNC.SY_', 'D:' + BS + 'KKCFUNC.SYS'],
		['D:' + BS + 'MOUSE.CO_', 'D:' + BS + 'MOUSE.COM'],
		['E:' + BS + 'MSIMEK.SY_', 'D:' + BS + 'MSIMEK.SYS'],
		['E:' + BS + 'MSIMEI.SY_', 'D:' + BS + 'MSIMEI.SYS'],
		['E:' + BS + 'MSIMED.SY_', 'D:' + BS + 'MSIMED.SYS'],
		// The dictionaries are large, and MSIMEK looks for them on C: anyway.
		['E:' + BS + 'MSIME.DI_', 'C:' + BS + 'MSIME.DIC'],
		['E:' + BS + 'MSIMER.DI_', 'C:' + BS + 'MSIMER.DIC'],
	].map(([a, b]) => 'D:' + BS + 'EXPAND.EXE ' + a + ' ' + b);
	return [
		'@echo off',
		'ECHO MS-DOS の起動ディスクを組み立てています...',
		'IMGMOUNT D ' + MSDOS_DIR + '/DISK1.IMG -t floppy',
		'IMGMOUNT E ' + MSDOS_DIR + '/DISK3.IMG -t floppy',
		...del,
		...expand,
		'COPY C:' + BS + 'CFG' + BS + 'CONFIG.SYS D:' + BS + 'CONFIG.SYS',
		'COPY C:' + BS + 'CFG' + BS + 'AUTOEXEC.BAT D:' + BS + 'AUTOEXEC.BAT',
		'IMGMOUNT -u E',
		'IMGMOUNT -u D',
		'IMGMOUNT A ' + MSDOS_DIR + '/DISK1.IMG -t floppy',
		'BOOT -l A',
		'',
	].join(String.fromCharCode(13, 10));
}

// The device order follows the setup disk's own CONFIG.SYS.
const GUEST_CONFIG_SYS = [
	'device=' + BS + 'biling.sys',
	'device=' + BS + '$font.sys /u=0',
	'device=' + BS + '$disp.sys',
	'device=' + BS + 'dosvsys.sys',
	'device=' + BS + 'kkcfunc.sys',
	'device=' + BS + 'msimek.sys',
	'device=' + BS + 'msimei.sys',
	'files=30',
	'buffers=20',
	'',
].join(String.fromCharCode(13, 10));

function guestAutoexec(videoMode) {
	return [
		'@echo off',
		'path a:' + BS,
		// Booting a guest OS takes away DOSBox-X's own INT 33h, and JW_CAD
		// refuses to start without a mouse driver.
		'a:' + BS + 'mouse',
		'c:',
		'cd ' + BS + 'JWCAD',
		'JW_CADV.EXE ' + videoMode,
		'',
	].join(String.fromCharCode(13, 10));
}

function buildConf(videoMode) {
	// With the user's MS-DOS on board, boot it: the IME then runs inside DOS
	// and converts in JW_CAD's own text field, with no browser input box.
	if (msdosInstalled()) return msdosConf();
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

${devices}[autoexec]
@echo off
${mount}c:
cd \\JWCAD
JW_CADV.EXE ${videoMode}
`;
}

// Booting a real DOS changes what DOSBox-X is responsible for: its own DOS,
// its DOS/V emulation and its INT 33h all step aside, and the disks supply
// them instead.
function msdosConf() {
	return `# generated by jwcad.js
[sdl]
autolock=false
output=surface
windowresolution=original
showmenu=false

[dosbox]
machine=svga_s3
memsize=16
title=JW_CAD
dpi aware=false

# The disks bring their own DOS/V drivers, so DOSBox-X's emulation stays out.
[dosv]
dosv=off

[cpu]
core=normal
cputype=pentium
cycles=fixed 30000

[render]
scaler=none
aspect=false

# Zero means no simulated transfer delay. That delay loop spins on
# CALLBACK_Idle(), which Asyncify cannot be unwound from.
[dos]
hard drive data rate limit=0
floppy drive data rate limit=0

# A booted DOS needs a real mouse to talk to.
[keyboard]
auxdevice=intellimouse

[autoexec]
@echo off
MOUNT C ${WORK}
C:
CALL C:${BS}PREP.BAT
`;
}

/**
 * Install everything the emulator needs into the (already mounted) IDBFS.
 * Returns true if anything was written.
 */
async function install(pendingArchives, videoMode) {
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

	// Rewritten every start: they are generated, and the video mode can change.
	if (msdosInstalled()) {
		const enc = new TextEncoder();
		try { FS.mkdir(MSDOS_CFG); } catch { /* already there */ }
		FS.writeFile(WORK + '/PREP.BAT', enc.encode(prepBatch()));
		FS.writeFile(MSDOS_CFG + '/CONFIG.SYS', enc.encode(GUEST_CONFIG_SYS));
		FS.writeFile(MSDOS_CFG + '/AUTOEXEC.BAT', enc.encode(guestAutoexec(videoMode)));
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
					const dirty = await install(pendingArchives, videoMode);
					pendingArchives = [];
					if (dirty) await syncfs(false);
					FS.writeFile('/dosbox-x.conf', buildConf(videoMode));
					updateFepState();
					updateMsdosState();
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

// The disk images are the user's own; nothing Microsoft is distributed here.
// Only disks 1 and 3 are needed - the DOS/V drivers and the IME - and both are
// padded to a full 1.44MB, because the images that circulate are trimmed while
// their BPB still claims the full size, which makes DOS read past the end.
const FLOPPY_BYTES = 1474560;

function padFloppy(bytes) {
	if (bytes.length >= FLOPPY_BYTES) return bytes;
	const out = new Uint8Array(FLOPPY_BYTES);
	out.set(bytes);
	return out;
}

function updateMsdosState() {
	const el = $('dos-state');
	if (!el) return;
	const on = FS && msdosInstalled();
	el.textContent = on ? '導入済み' : '未導入';
	el.className = on ? '' : 'off';
}

$('dos-file').onchange = async (ev) => {
	const file = ev.target.files[0];
	ev.target.value = '';
	if (!file) return;
	if (!FS) { setStatus('起動を待ってから入れてください。', true); return; }
	try {
		setStatus('MS-DOS のディスクイメージを読んでいます…');
		const entries = await readZip(new Uint8Array(await file.arrayBuffer()));
		const imgs = entries.filter((e) => /\.img$/i.test(e.name))
			.sort((a, b) => a.name.localeCompare(b.name));
		const pick = (n) => imgs.find((e) => new RegExp('disk\\s*' + n, 'i').test(e.name))
			|| imgs[n - 1];
		const d1 = pick(1);
		const d3 = pick(3);
		if (!d1 || !d3) throw new Error('ディスク 1 と 3 のイメージが見つかりません');

		try { FS.mkdir(MSDOS_DIR); } catch { /* already there */ }
		FS.writeFile(MSDOS_DIR + '/DISK1.IMG', padFloppy(d1.bytes));
		FS.writeFile(MSDOS_DIR + '/DISK3.IMG', padFloppy(d3.bytes));
		await syncfs(false);
		updateMsdosState();
		setStatus('MS-DOS を入れました。再起動すると DOS 上の MSIME で入力できます。');
	} catch (e) {
		setStatus('MS-DOS を読めませんでした: ' + e.message, true);
		console.error(e);
	}
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

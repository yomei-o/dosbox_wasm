#!/bin/sh
#
# Build the two WebAssembly modules this page needs:
#
#   web/dosbox-x.js / .wasm   DOSBox-X with DOS/V (Japanese) emulation
#   web/lzh.js     / .wasm    lhasa, for unpacking the .lzh archives in the browser
#   web/pdf.js     / .wasm    libharu, for writing a plot out as PDF
#
# Needs a POSIX environment with autotools (DOSBox-X uses autoconf/automake) and
# the Emscripten SDK. On Windows, WSL works; MSYS2/Git Bash does not, because
# emcc does not cope with its path translation.
#
# Usage:
#   scripts/build-wasm.sh [dosbox|lzh|pdf]   (default: all)
#
# Environment:
#   EMSDK           existing emsdk installation to use
#   EMSDK_VERSION   emsdk release to install when bootstrapping (default 3.1.57)
#   DOSBOX_X_SRC    existing DOSBox-X checkout to build (default: fetched into .build/)
#   JOBS            parallel compile jobs
#
set -e

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
BUILD=${BUILD:-$ROOT/.build}
WEB=$ROOT/web
# DOSBox-X's own build-emscripten-sdl2 says 3.1.28, but that release has no
# linux-arm64 binaries; 3.1.57 is the oldest one that does and builds cleanly.
EMSDK_VERSION=${EMSDK_VERSION:-3.1.57}
# Half the cores, at the lowest priority: this build is long enough that it
# should not make the machine unusable while it runs.
JOBS=${JOBS:-$( (nproc 2>/dev/null || echo 4) )}
JOBS=$(( JOBS > 2 ? JOBS / 2 : 1 ))
NICE=${NICE:-"nice -n 19"}

mkdir -p "$BUILD" "$WEB"

# The exact upstream revisions these binaries are built from. Bump deliberately,
# not by drifting: a shipped .wasm has to be traceable to a source tree.
DOSBOX_X_REV=${DOSBOX_X_REV:-145d6a1}
LIBHARU_REV=${LIBHARU_REV:-3467749fd1c0ab6ca6ed424d053b1ea53c1bf67c}
LHASA_REV=${LHASA_REV:-master}

# Clone at a revision. A shallow clone cannot be checked out to an arbitrary
# commit, so fetch that one commit directly.
fetch_at() {
	url=$1; dir=$2; rev=$3
	if [ ! -d "$dir/.git" ]; then
		mkdir -p "$dir"
		git -C "$dir" init -q
		git -C "$dir" remote add origin "$url"
	fi
	git -C "$dir" fetch -q --depth 1 origin "$rev"
	git -C "$dir" checkout -q FETCH_HEAD
	echo "    $(basename "$dir") at $(git -C "$dir" rev-parse --short HEAD)"
}

# ---------------------------------------------------------------- toolchain
# emsdk_env.sh is avoided on purpose: it probes for `python` on PATH, and some
# systems answer that probe with something that is not a working Python.
activate_emsdk() {
	root=$1
	[ -f "$root/upstream/emscripten/emcc.py" ] || return 1
	EMSDK=$root
	EM_CONFIG=$root/.emscripten
	export EMSDK EM_CONFIG
	PATH=$root/upstream/emscripten:$PATH
	node_dir=$(ls -d "$root"/node/*/bin 2>/dev/null | head -n 1)
	[ -n "$node_dir" ] && PATH=$node_dir:$PATH
	export PATH
	return 0
}

if command -v emcc >/dev/null 2>&1; then
	echo "==> using emcc already on PATH"
elif [ -n "$EMSDK" ] && activate_emsdk "$EMSDK"; then
	echo "==> using emsdk at $EMSDK"
else
	emsdk_root=$BUILD/emsdk
	if ! activate_emsdk "$emsdk_root"; then
		echo "==> bootstrapping emsdk $EMSDK_VERSION into $emsdk_root"
		[ -d "$emsdk_root/.git" ] || git clone --depth 1 \
			https://github.com/emscripten-core/emsdk "$emsdk_root"
		"$emsdk_root/emsdk" install "$EMSDK_VERSION"
		"$emsdk_root/emsdk" activate "$EMSDK_VERSION"
		activate_emsdk "$emsdk_root"
	fi
	echo "==> using emsdk at $emsdk_root"
fi
emcc --version | head -n 1

want=${1:-all}

# ------------------------------------------------------------------- lhasa
build_lzh() {
	L=$BUILD/lhasa
	fetch_at https://github.com/fragglet/lhasa "$L" "$LHASA_REV"
	lib=$L/lib
	echo "==> building lzh.wasm"
	# bit_stream_reader.c, lh_new_decoder.c, pma_common.c and tree_decode.c are
	# #included by the decoders rather than compiled separately (they are
	# EXTRA_DIST in lhasa's lib/Makefile.am), so they are not listed here.
	$NICE emcc -O2 -I"$lib" -I"$lib/public" \
		"$ROOT/src/lzhwasm/lzhwasm.c" \
		"$lib"/crc16.c "$lib"/ext_header.c "$lib"/lha_arch_unix.c \
		"$lib"/lha_decoder.c "$lib"/lha_endian.c "$lib"/lha_file_header.c \
		"$lib"/lha_input_stream.c "$lib"/lha_basic_reader.c "$lib"/lha_reader.c \
		"$lib"/macbinary.c "$lib"/null_decoder.c \
		"$lib"/lh1_decoder.c "$lib"/lh5_decoder.c "$lib"/lh6_decoder.c \
		"$lib"/lh7_decoder.c "$lib"/lhx_decoder.c "$lib"/lk7_decoder.c \
		"$lib"/lz5_decoder.c "$lib"/lzs_decoder.c "$lib"/pm1_decoder.c \
		"$lib"/pm2_decoder.c \
		-o "$WEB/lzh.js" \
		-sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createLzh \
		-sEXPORTED_FUNCTIONS='["_lzh_extract","_lzh_free","_lzh_alloc","_malloc","_free"]' \
		-sEXPORTED_RUNTIME_METHODS='["HEAPU8","HEAPU32","getValue"]' \
		-sALLOW_MEMORY_GROWTH=1 -sFILESYSTEM=0 -sENVIRONMENT=web,node
	ls -l "$WEB"/lzh.js "$WEB"/lzh.wasm
}

# ------------------------------------------------------------------ libharu
# A plot carries its text as Shift-JIS, and PDF's standard 90ms-RKSJ-H encoding
# takes those bytes as they are, so Japanese comes out as real text with no
# font embedded. That is why this is libharu rather than something written by
# hand in JavaScript.
build_pdf() {
	H=$BUILD/haru
	fetch_at https://github.com/libharu/libharu "$H" "$LIBHARU_REV"
	# The config header only ever sets four optional flags; without zlib and
	# libpng every one of them stays off, so an empty file is the whole config.
	[ -f "$H/include/hpdf_config.h" ] || : > "$H/include/hpdf_config.h"

	echo "==> building pdf.wasm"
	$NICE emcc -O2 -I"$H/include" \
		"$ROOT/src/pdfwasm/pdfwasm.c" "$H"/src/*.c \
		-o "$WEB/pdf.js" \
		-sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createPdf \
		-sEXPORTED_FUNCTIONS='["_pdf_begin","_pdf_color","_pdf_width","_pdf_dash","_pdf_move","_pdf_line","_pdf_stroke","_pdf_arc","_pdf_dot","_pdf_text","_pdf_end","_pdf_data","_pdf_release","_malloc","_free"]' \
		-sEXPORTED_RUNTIME_METHODS='["HEAPU8","stringToUTF8","lengthBytesUTF8"]' \
		-sALLOW_MEMORY_GROWTH=1 -sFILESYSTEM=0 -sENVIRONMENT=web,node
	ls -l "$WEB"/pdf.js "$WEB"/pdf.wasm
}

# ---------------------------------------------------------------- DOSBox-X
build_dosbox() {
	D=${DOSBOX_X_SRC:-$BUILD/dosbox-x}
	fetch_at https://github.com/joncampbell123/dosbox-x "$D" "$DOSBOX_X_REV"
	cd "$D"

	echo "==> applying source fixes"
	python3 "$ROOT/scripts/patch-dosbox-x.py" "$D"

	if [ ! -f Makefile ] || [ -n "$RECONFIGURE" ]; then
		echo "==> autogen"
		./autogen.sh
		export PATH="$EMSDK/upstream/emscripten/system/bin:$PATH"
		export CC=emcc CXX=em++ LD=emcc LD_CXX=em++ AR=emar RANLIB=emranlib
		export CFLAGS="-O2"
		export CXXFLAGS="-O2 -DEMSCRIPTEN=1 -sUSE_ZLIB=1 -sUSE_LIBPNG=1 -sUSE_SDL=2 -sUSE_SDL_NET=2"
		# IDBFS is what makes the emulated C: drive survive a page reload, and
		# the page drives the filesystem from its own module scope, so FS and
		# the run-dependency hooks have to be exported.
		export LDFLAGS="-O2 -DEMSCRIPTEN=1 -sUSE_ZLIB=1 -sUSE_LIBPNG=1 -sUSE_SDL=2 -sUSE_SDL_NET=2 \
-sFORCE_FILESYSTEM=1 -sALLOW_MEMORY_GROWTH=1 -sTOTAL_MEMORY=100663296 \
-sASYNCIFY -sASYNCIFY_STACK_SIZE=131072 -sERROR_ON_UNDEFINED_SYMBOLS=0 \
-lidbfs.js -sEXPORTED_RUNTIME_METHODS=FS,IDBFS,MEMFS,addRunDependency,removeRunDependency,callMain"
		chmod +x configure vs/sdl/build-scripts/strip_fPIC.sh 2>/dev/null || true
		echo "==> configure"
		./configure \
			--host=x86_64-linux --disable-dynrec --disable-dynamic-x86 \
			--disable-fpu-x86 --disable-dynamic-core \
			--enable-sdl2 --with-sdl-prefix="$EMSDK/upstream/emscripten/system" \
			--disable-screenshots --disable-opengl --disable-mt32 \
			--enable-emscripten --enable-force-menu-sdldraw --disable-x11 \
			--disable-avcodec --disable-libslirp --disable-libfluidsynth \
			--disable-freetype --disable-gamelink
	fi

	echo "==> make -j$JOBS"
	$NICE make -j"$JOBS"
	cp src/dosbox-x "$WEB/dosbox-x.js"
	cp src/dosbox-x.wasm "$WEB/dosbox-x.wasm"
	ls -l "$WEB"/dosbox-x.js "$WEB"/dosbox-x.wasm
}

case $want in
	lzh) build_lzh ;;
	pdf) build_pdf ;;
	dosbox) build_dosbox ;;
	all) build_lzh; build_pdf; build_dosbox ;;
	*) echo "usage: $0 [dosbox|lzh|pdf]" >&2; exit 2 ;;
esac

echo
echo "==> done. Serve the repository root and open web/."

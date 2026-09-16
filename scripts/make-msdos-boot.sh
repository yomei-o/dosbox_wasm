#!/bin/sh
#
# Build a bootable MS-DOS 5.0/V floppy carrying the DOS/V stack and a Japanese
# FEP, for the experimental "boot a real DOS" pages in .build/.
#
# Nothing this script needs is in the repository, and none of it can be: MS-DOS
# 5.0/V is Microsoft's, and WXP may not be redistributed. You supply them.
#
#   $BUILD/msdos/Disk1_full.IMG   MS-DOS 5.0/V setup disk 1, padded to
#                                 1,474,560 bytes (the images that circulate are
#                                 trimmed to ~2,256 sectors while the BPB still
#                                 claims 2,880, so reads past the end fail with
#                                 "Non-System disk or disk error")
#   $BUILD/msdos/dosvout/MOUSE.CO_   from the same disk, still SZDD-compressed
#   $BUILD/msime/                 MSIMEK.SYS MSIMEI.SYS MSIMED.SYS KKCFUNC.SYS
#   $WXP/                         wxp.sys wxdp.sys jisho01.dic jisho02.dic
#                                 (only for the wxp variant)
#
# Usage:
#   scripts/make-msdos-boot.sh            BOOTIME.IMG  - MSIME, starts JW_CAD
#   scripts/make-msdos-boot.sh prompt     BOOTPRMT.IMG - MSIME, stops at C>
#   scripts/make-msdos-boot.sh wxp        BOOTWXP.IMG  - WXP, stops at C>
#
# The prompt variants exist because judging the keyboard and the FEP through
# JW_CAD confuses two questions at once. At the prompt a keystroke either
# echoes or it does not.
#
# Starts from the setup disk, which is already bootable and already carries the
# DOS/V drivers, then removes what setup needs and adds the FEP. IO.SYS is left
# exactly where it is: the boot sector expects it at the first data cluster.
set -e

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
BUILD=${BUILD:-$ROOT/.build}
WXP=${WXP:-$BUILD/wxp-src}
export MTOOLS_SKIP_CHECK=1

cd "$BUILD/msdos" || exit 1

IMG=BOOTIME.IMG
[ "$1" = prompt ] && IMG=BOOTPRMT.IMG
[ "$1" = wxp ] && IMG=BOOTWXP.IMG
cp Disk1_full.IMG "$IMG"

# Setup's own files, and the parts of DOS that bringing up an FEP does not need.
for f in SETUP.COM SETUP.EXE SETUP2.EXE SETUP.INI SETUPE.BAT SETUPJ.BAT \
         PACKING.LST README.TXT WINA20.38_ COUNTRY.SYS KEYBOARD.SYS \
         KEYB.COM NLSFUNC.EXE EMM386.EX_ HIMEM.SY_ ANSI.SY_ SETVER.EX_ \
         '$JPNZN24.ES_' '$SYS1Z24.FN_' '$SYS1Z16.FN_' AUTOEXEC.BAT CONFIG.SYS; do
    mdel -i "$IMG" "::$f" 2>/dev/null || true
done

# Booting a real DOS takes away the INT 33h that DOSBox-X's own DOS layer was
# providing, and JW_CAD refuses to start without a mouse driver. MOUSE.CO_ is
# already on the disk but still compressed, so DOS cannot run it as it stands.
msexpand < "$BUILD/msdos/dosvout/MOUSE.CO_" > /tmp/MOUSE.COM 2>/dev/null &&
    mcopy -i "$IMG" /tmp/MOUSE.COM :: 2>/dev/null && echo "  added MOUSE.COM" || true

if [ "$1" = wxp ]; then
    for f in wxp.sys wxdp.sys; do
        mcopy -i "$IMG" "$WXP/$f" :: 2>/dev/null && echo "  added $f" || true
    done
    # WXP looks for its dictionaries on A: by default, and at 650K they do not
    # fit next to the driver. C: is assembled by the page fetching files, so
    # stage them where the page can reach them and point /D1 and /D3 there.
    mkdir -p "$BUILD/wxp"
    for f in jisho01.dic jisho02.dic; do
        cp "$WXP/$f" "$BUILD/wxp/$(echo "$f" | tr a-z A-Z)" && echo "  staged $f for C:"
    done
else
    for f in MSIMEK.SYS MSIMEI.SYS MSIMED.SYS KKCFUNC.SYS; do
        mcopy -i "$IMG" "$BUILD/msime/$f" :: 2>/dev/null && echo "  added $f" || true
    done
fi

# The device order follows the setup disk's own CONFIG.SYS.
if [ "$1" = wxp ]; then
cat > /tmp/CONFIG.SYS <<'CFG'
device=\biling.sys
device=\$font.sys /u=0
device=\$disp.sys
device=\dosvsys.sys
device=\wxp.sys /D1C:\JISHO01.DIC /D3C:\JISHO02.DIC
device=\wxdp.sys
files=30
buffers=20
CFG
else
cat > /tmp/CONFIG.SYS <<'CFG'
device=\biling.sys
device=\$font.sys /u=0
device=\$disp.sys
device=\dosvsys.sys
device=\kkcfunc.sys
device=\msimek.sys
device=\msimei.sys
files=30
buffers=20
CFG
fi

if [ "$1" = prompt ] || [ "$1" = wxp ]; then
cat > /tmp/AUTOEXEC.BAT <<'AUT'
@echo off
path a:\
a:\mouse
echo MS-DOS 5.0/V - stopping at the prompt
c:
AUT
else
cat > /tmp/AUTOEXEC.BAT <<'AUT'
@echo off
path a:\
a:\mouse
echo MS-DOS 5.0/V with MSIME
c:
cd \jwcad
jw_cadv -V12
AUT
fi

# DOS wants CRLF in these.
sed -i 's/$/\r/' /tmp/CONFIG.SYS /tmp/AUTOEXEC.BAT
mcopy -i "$IMG" /tmp/CONFIG.SYS :: 2>/dev/null && echo "  added CONFIG.SYS" || true
mcopy -i "$IMG" /tmp/AUTOEXEC.BAT :: 2>/dev/null && echo "  added AUTOEXEC.BAT" || true

echo "=== $IMG ==="
mdir -i "$IMG" -a :: 2>/dev/null | tail -3 || true
ls -l "$IMG"

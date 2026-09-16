#!/usr/bin/env python3
"""Apply this project's DOSBox-X source fixes.

Written as exact string edits rather than a diff so that it keeps applying as
upstream moves around. Re-running is a no-op.

Usage: scripts/patch-dosbox-x.py <path to dosbox-x checkout>
"""

import sys
import pathlib

# Startup stops dead inside SDL_InitSubSystem(SDL_INIT_JOYSTICK) in the
# browser - the last thing DOSBox-X logs is "Initializing SDL joystick
# subsystem..." and nothing follows, however long you wait. Neither joysticks
# nor CD-ROM are reachable from wasm, so skip both.
JOYSTICK_OLD = """        if (SDL_InitSubSystem(SDL_INIT_JOYSTICK) >= 0) {
            sdl.num_joysticks = (Bitu)SDL_NumJoysticks();
            LOG(LOG_MISC,LOG_DEBUG)("SDL reports %u joysticks",(unsigned int)sdl.num_joysticks);
        }
        else {
            LOG(LOG_GUI,LOG_WARN)("Failed to init joystick support");
            sdl.num_joysticks = 0;
        }
"""

JOYSTICK_NEW = """#if C_EMSCRIPTEN
        /* SDL_InitSubSystem(SDL_INIT_JOYSTICK) never returns under Emscripten. */
        sdl.num_joysticks = 0;
#else
""" + JOYSTICK_OLD + """#endif
"""

CDROM_OLD = """#if defined(C_SDL2)
        if (SDL_CDROMInit() < 0) {
#else
        if (SDL_InitSubSystem(SDL_INIT_CDROM) < 0) {
#endif
            LOG(LOG_GUI,LOG_WARN)("Failed to init CD-ROM support");
        }
"""

CDROM_NEW = """#if !C_EMSCRIPTEN
""" + CDROM_OLD + """#endif
"""

# DOSBox-X already knows how to deliver text typed with a host IME: its
# SDL_TEXTINPUT handler encodes the text to the guest code page and pushes the
# bytes into the BIOS keyboard buffer, which is exactly how a DOS FEP hands
# over a converted string. That whole handler is behind a #if for Win32/X11/
# macOS, so the Emscripten build has no way in at all.
#
# Rather than try to make Emscripten's SDL2 produce SDL_TEXTINPUT with IME
# composition, expose the last step directly and let the page drive it. The
# page can then offer a plain text field, let the browser's own IME do the
# conversion, and send the result here.
TYPE_ANCHOR = """#if C_EMSCRIPTEN
# include <emscripten.h>
#endif
"""

TYPE_NEW = TYPE_ANCHOR + """
#if C_EMSCRIPTEN
/* Push bytes that are already in the guest code page (Shift_JIS under
 * dosv=jp) into the BIOS keyboard buffer. Returns how many were accepted; the
 * buffer is small, so the caller is expected to send the rest later. */
extern "C" EMSCRIPTEN_KEEPALIVE int dosbox_x_type_bytes(const unsigned char *s, int len) {
    int n = 0;
    for (int i = 0; i < len; i++) {
        if (!BIOS_AddKeyToBuffer(s[i])) break;
        n++;
    }
    return n;
}
#endif
"""

# Mouse alignment is hard to judge from the outside: a canvas screenshot often
# catches a half-drawn frame, so the guest cursor cannot be measured from
# pixels. Export the numbers instead - where SDL thinks the pointer is, what
# the clipping rectangle is, and where the guest cursor actually ended up - so
# the page can compare them directly.
MOUSE_POS_ANCHOR = """void Mouse_CursorMoved(float xrel,float yrel,float x,float y,bool emulate) {
"""

MOUSE_POS_NEW = """#if C_EMSCRIPTEN
extern "C" void Mouse_EmscriptenGetState(float *out) {
    out[0] = mouse.x;
    out[1] = mouse.y;
    out[2] = mouse.min_x;
    out[3] = mouse.max_x;
    out[4] = mouse.min_y;
    out[5] = mouse.max_y;
    out[6] = (float)mouse.max_screen_x;
    out[7] = (float)mouse.max_screen_y;
}
#endif

""" + MOUSE_POS_ANCHOR

# The probe has to sit after user_cursor_x/y are declared, which is most of the
# way down the file, so it hangs off that declaration rather than the include
# block at the top.
PROBE_ANCHOR = """int user_cursor_x = 0,user_cursor_y = 0;
"""

PROBE_NEW = PROBE_ANCHOR + """
#if C_EMSCRIPTEN
extern "C" void Mouse_EmscriptenGetState(float *out);

/* Snapshot of everything that decides where the guest cursor lands, so that
 * the page can check the mapping without trying to read it off the canvas:
 *   0-3   clip rectangle (x, y, w, h) inside the SDL window
 *   4,5   last host pointer position, relative to the clip origin
 *   6     mouse captured
 *   7     autolock
 *   8,9   guest cursor
 *   10,11 guest cursor range (max_x, max_y)
 *   12,13 guest screen size the driver reports
 */
static float dosbox_x_mouse_probe_buf[16];

extern "C" EMSCRIPTEN_KEEPALIVE float *dosbox_x_mouse_probe(void) {
    float *b = dosbox_x_mouse_probe_buf;
    b[0] = (float)sdl.clip.x;
    b[1] = (float)sdl.clip.y;
    b[2] = (float)sdl.clip.w;
    b[3] = (float)sdl.clip.h;
    b[4] = (float)user_cursor_x;
    b[5] = (float)user_cursor_y;
    b[6] = sdl.mouse.locked ? 1.0f : 0.0f;
    b[7] = sdl.mouse.autoenable ? 1.0f : 0.0f;
    float st[8];
    Mouse_EmscriptenGetState(st);
    b[8] = st[0];
    b[9] = st[1];
    b[10] = st[3];
    b[11] = st[5];
    b[12] = st[6];
    b[13] = st[7];
    return b;
}
#endif
"""

# After BOOT hands control to a guest OS the screen goes black and stays that
# way, with no error logged. A blank canvas cannot distinguish "the CPU stopped"
# from "the CPU is fine but nothing is reaching the canvas", so report where the
# emulated CPU actually is - sample it twice and see whether it moved.
CPU_PROBE_NEW = PROBE_ANCHOR + """
#if C_EMSCRIPTEN
/* 0,1  CS:IP    2  protected mode    3  cycles left in this block */
static uint32_t dosbox_x_cpu_probe_buf[8];

extern "C" EMSCRIPTEN_KEEPALIVE uint32_t *dosbox_x_cpu_probe(void) {
    uint32_t *b = dosbox_x_cpu_probe_buf;
    b[0] = (uint32_t)SegValue(cs);
    b[1] = (uint32_t)reg_eip;
    b[2] = (uint32_t)(cpu.pmode ? 1 : 0);
    b[3] = (uint32_t)CPU_Cycles;
    return b;
}
#endif
"""

# When the guest wedges inside the emulated BIOS, the address alone says
# nothing. DOSBox's callback area is a contiguous run of CB_SIZE-byte stubs and
# every callback keeps the name it was allocated with, so an address maps to a
# name - which turns "stuck at f000:cf45" into "stuck in <whatever that is>".
CB_PROBE_NEW = PROBE_ANCHOR + """
#if C_EMSCRIPTEN
extern char* CallBack_Description[];

static char dosbox_x_cb_name_buf[160];

extern "C" EMSCRIPTEN_KEEPALIVE const char *dosbox_x_callback_at(uint32_t seg, uint32_t off) {
    char *b = dosbox_x_cb_name_buf;
    size_t n = sizeof(dosbox_x_cb_name_buf);

    if (seg != (uint32_t)CB_SEG || off < (uint32_t)CB_SOFFSET) {
        snprintf(b, n, "%04x:%04x is outside the callback area (%04x:%04x)",
                 (unsigned)seg, (unsigned)off, (unsigned)CB_SEG, (unsigned)CB_SOFFSET);
        return b;
    }

    unsigned int rel = (unsigned int)(off - (uint32_t)CB_SOFFSET);
    unsigned int idx = rel / CB_SIZE;
    if (idx >= CB_MAX) {
        snprintf(b, n, "%04x:%04x is past the last callback", (unsigned)seg, (unsigned)off);
        return b;
    }

    const char *d = CallBack_Description[idx];
    snprintf(b, n, "callback %u +%u: %s", idx, rel % CB_SIZE, d ? d : "(unnamed)");
    return b;
}
#endif
"""

# The guest wedges on the IRET right after the INT 13h callback, with the page
# still responsive - so the handler is not spinning, and the CPU simply stops.
# Log every entry and every exit: one entry with no exit means the handler
# never returned, repeated pairs mean something else is stopping the core.
INT13_ANCHOR = """static Bitu INT13_DiskHandler(void) {
"""

INT13_NEW = INT13_ANCHOR + """#if C_EMSCRIPTEN
    LOG_MSG("INT13 enter AH=%02x AL=%02x DL=%02x CH=%02x CL=%02x DH=%02x ES:BX=%04x:%04x",
        (unsigned)reg_ah,(unsigned)reg_al,(unsigned)reg_dl,(unsigned)reg_ch,
        (unsigned)reg_cl,(unsigned)reg_dh,(unsigned)SegValue(es),(unsigned)reg_bx);
    struct Int13Trace {
        ~Int13Trace() { LOG_MSG("INT13 leave AH=%02x CF=%u",(unsigned)reg_ah,(unsigned)(reg_flags&1)); }
    } int13_trace;
#endif
"""

EDITS = [
    # (file, find, replace, marker that means "already applied")
    ("src/gui/sdlmain.cpp", JOYSTICK_OLD, JOYSTICK_NEW, "SDL_InitSubSystem(SDL_INIT_JOYSTICK) never returns"),
    ("src/gui/sdlmain.cpp", CDROM_OLD, CDROM_NEW, "#if !C_EMSCRIPTEN\n#if defined(C_SDL2)"),
    ("src/gui/sdlmain.cpp", TYPE_ANCHOR, TYPE_NEW, "dosbox_x_type_bytes"),
    ("src/ints/mouse.cpp", MOUSE_POS_ANCHOR, MOUSE_POS_NEW, "Mouse_EmscriptenGetState"),
    ("src/gui/sdlmain.cpp", PROBE_ANCHOR, PROBE_NEW, "dosbox_x_mouse_probe"),
    ("src/gui/sdlmain.cpp", PROBE_ANCHOR, CPU_PROBE_NEW, "dosbox_x_cpu_probe"),
    ("src/gui/sdlmain.cpp", PROBE_ANCHOR, CB_PROBE_NEW, "dosbox_x_callback_at"),
    ("src/ints/bios_disk.cpp", INT13_ANCHOR, INT13_NEW, "INT13 enter AH="),
]


def main(root):
    root = pathlib.Path(root)
    changed = 0
    for rel, old, new, marker in EDITS:
        path = root / rel
        text = path.read_text(encoding="utf-8", errors="surrogateescape")
        if marker in text:
            print(f"  already applied: {rel} ({marker.splitlines()[0][:40]})")
            continue
        if text.count(old) != 1:
            print(f"  FAILED: {rel}: expected exactly one match, found {text.count(old)}")
            return 1
        path.write_text(text.replace(old, new), encoding="utf-8", errors="surrogateescape")
        print(f"  patched: {rel}")
        changed += 1
    print(f"{changed} edit(s) applied")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))

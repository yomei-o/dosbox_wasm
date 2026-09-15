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

EDITS = [
    ("src/gui/sdlmain.cpp", JOYSTICK_OLD, JOYSTICK_NEW),
    ("src/gui/sdlmain.cpp", CDROM_OLD, CDROM_NEW),
]


def main(root):
    root = pathlib.Path(root)
    changed = 0
    for rel, old, new in EDITS:
        path = root / rel
        text = path.read_text(encoding="utf-8", errors="surrogateescape")
        if new in text:
            print(f"  already applied: {rel}")
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

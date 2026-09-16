# wxpkey — DOS-side pieces for driving WXP

Small DOS programs written for this project, in NASM syntax. They are **not
used by the page**: the Japanese input you get at
<https://yomei-o.github.io/dosbox_wasm/> goes through the browser's own IME,
not through a DOS FEP. These exist because the FEP route was investigated, and
they record what was found.

```sh
nasm -f bin wxpkey.asm -o WXPKEY.COM
```

## What was found

WXP never watches the keyboard for its own activation. It publishes a control
interface on **INT 6Ch** and waits to be called:

```
mov ax,4C00h / int 6Ch               AL = current state, 0 = off
mov ah,00h / mov al,0|1 / int 6Ch    set state
```

That is exactly what `wxpdosv` does from its INT 15h AH=4Fh handler, and it is
why WXP sits resident and unresponsive on its own — nothing ever calls it.

Under DOSBox-X the query works and the set does not:

| | |
|---|---|
| INT 6Ch vector | `0464:71E0`, inside WXP.SYS. Live. |
| `AX=4C00h` (query) | returns cleanly, `AL=0` |
| `AH=00h, AL=01h` (set on) | **the emulator wedges and never comes back** |

The set was tried from three different contexts — the keyboard IRQ, an INT 16h
hook in application context, and a plain .COM on its own — and wedges the same
way in all three, so it is WXP that does not return, not the caller. Most
likely it goes off to draw its conversion area through J-3100 display BIOS that
DOSBox-X does not provide. That display layer is what `wxpdosv` emulates, and
`wxpdosv` itself resets the machine under DOSBox-X.

See `resume.md` section 3 for the routes that are left.

## The files

| | |
|---|---|
| `wxpkey.asm` | TSR: catches Scroll Lock in INT 15h AH=4Fh, toggles WXP on the next INT 16h. Correct as far as it goes, but unusable until the set call stops wedging. |
| `wxprobe.asm` | Prints the INT 6Ch vector and the current FEP state. |
| `wxpon.asm` | Does only the set call, with a marker either side, so a screenshot shows exactly where it stops. |
| `keyspy.asm` | Prints every scancode arriving at INT 15h AH=4Fh. Used to confirm the hook fires and that Scroll Lock arrives as `46h`. |

One thing worth keeping from `wxpkey.asm` whatever happens: **calling INT 6Ch
from inside the keyboard interrupt wedges the machine outright** — the handler
does not reach its next instruction. A TSR has to raise a flag in the interrupt
and do the work from INT 16h instead.

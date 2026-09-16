; WXPKEY.COM - turn WXP (the J-3100 FEP) on and off with a key.
;
; WXP never watches the keyboard for its own activation. It publishes a control
; interface on INT 6Ch and waits to be called:
;
;       mov ax,4C00h / int 6Ch               AL = current state, 0 = off
;       mov ah,00h / mov al,0|1 / int 6Ch    set state
;
; On a J-3100 the machine's own software did that. On DOS/V, wxpdosv does -
; but it also emulates a pile of J-3100 display BIOS (INT 10h, 29h, 60h) that
; DOSBox-X already provides, and under DOSBox-X it resets the machine shortly
; after WXP loads. This does only the part that is actually missing.
;
; The key is caught in INT 15h AH=4Fh, the BIOS scancode filter, which
; DOSBox-X's IRQ1 callback issues for every scancode (verified: Scroll Lock
; arrives there as 46h). Calling WXP from that handler does not work - INT 6Ch
; inside the keyboard interrupt wedges the machine, and the handler never
; reaches its next instruction. So the interrupt only raises a flag, and the
; toggle happens on the next INT 16h, in application context, which is where
; WXP expects to be called from.
;
; Assemble with:  nasm -f bin wxpkey.asm -o WXPKEY.COM

        bits 16
        org 0x100

        jmp     setup

; ------------------------------------------------------------- resident part

signature       db 'WXPKEY02'           ; so a second run can tell we are here
old15           dd 0
old16           dd 0
pending         db 0

TOGGLE_SCAN     equ 0x46                ; Scroll Lock: free on a browser keyboard

int15_handler:
        pushf
        cmp     ah, 0x4f                ; keyboard scancode filter?
        jne     .chain
        cmp     al, TOGGLE_SCAN
        jne     .chain

        mov     byte [cs:pending], 1    ; do the real work outside the interrupt
        popf
        clc                             ; CF clear: swallow the key
        ret     2

.chain:
        popf
        jmp     far [cs:old15]

int16_handler:
        cmp     byte [cs:pending], 0
        je      .chain

        mov     byte [cs:pending], 0
        pushf
        push    ax
        push    bx
        push    es

        mov     ax, 0x4c00
        int     0x6c                    ; what is WXP doing at the moment?
        or      al, al
        jz      .turn_on
        mov     al, 0x00                ; on, so turn it off
        jmp     short .apply
.turn_on:
        mov     al, 0x01
.apply:
        mov     ah, 0x00
        push    ax
        int     0x6c

        pop     ax                      ; show which way it went, so that a
        push    ax                      ; screenshot can confirm the toggle
        add     al, '0'
        mov     ah, 0x0e
        mov     bx, 0x0007
        int     0x10
        pop     ax

        pop     es
        pop     bx
        pop     ax
        popf

.chain:
        jmp     far [cs:old16]

resident_end:

; ----------------------------------------------------------------- installer

setup:
        ; Already resident? Compare the signature where INT 15h now points.
        mov     ax, 0x3515
        int     0x21                    ; ES:BX = current INT 15h
        mov     ax, es
        or      ax, ax
        jz      .install
        push    ds
        mov     ds, ax
        mov     si, signature           ; a resident copy is also a .COM, so
        mov     di, signature           ; the offset is the same as ours
        push    cs
        pop     es
        mov     cx, 8
        repe    cmpsb
        pop     ds
        jne     .install

        mov     dx, msg_already
        mov     ah, 9
        int     0x21
        mov     ax, 0x4c01
        int     0x21

.install:
        mov     ax, 0x3515
        int     0x21
        mov     [old15], bx
        mov     [old15 + 2], es

        mov     ax, 0x3516
        int     0x21
        mov     [old16], bx
        mov     [old16 + 2], es

        push    ds
        push    cs
        pop     ds
        mov     ax, 0x2515
        mov     dx, int15_handler
        int     0x21
        mov     ax, 0x2516
        mov     dx, int16_handler
        int     0x21
        pop     ds

        mov     dx, msg_ok
        mov     ah, 9
        int     0x21

        ; Paragraphs to keep, counted from the PSP. $$ is the org, so
        ; resident_end - $$ is the image size and 0x100 is the PSP.
        mov     dx, ((resident_end - $$) + 0x100 + 15) >> 4
        mov     ax, 0x3100
        int     0x21

msg_ok:      db 'WXPKEY: Scroll Lock toggles WXP', 13, 10, '$'
msg_already: db 'WXPKEY: already installed', 13, 10, '$'

; KEYSPY.COM - print every scancode that reaches INT 15h AH=4Fh.
;
; DOSBox-X's IRQ1 callback issues "mov ah,4Fh / stc / int 15h" per scancode, so
; a hook there should see everything. This prints the first 24 of them, to show
; whether the hook fires at all and what code a given key produces.

        bits 16
        org 0x100

        jmp     setup

old15   dd 0
count   dw 24

int15_handler:
        pushf
        cmp     ah, 0x4f
        jne     .chain

        cmp     word [cs:count], 0
        je      .chain
        dec     word [cs:count]

        push    ax
        push    bx
        push    cx
        push    dx
        mov     bl, al                  ; the scancode

        mov     al, bl
        shr     al, 4
        call    nibble
        mov     al, bl
        and     al, 0x0f
        call    nibble
        mov     al, ' '
        call    emit

        pop     dx
        pop     cx
        pop     bx
        pop     ax

.chain:
        popf
        jmp     far [cs:old15]

nibble:
        add     al, '0'
        cmp     al, '9'
        jbe     emit
        add     al, 7
emit:
        push    bx
        mov     ah, 0x0e
        mov     bx, 0x0007
        int     0x10
        pop     bx
        ret

resident_end:

setup:
        mov     ax, 0x3515
        int     0x21
        mov     [old15], bx
        mov     [old15 + 2], es

        push    ds
        mov     ax, 0x2515
        mov     dx, int15_handler
        push    cs
        pop     ds
        int     0x21
        pop     ds

        mov     dx, msg
        mov     ah, 9
        int     0x21

        mov     dx, ((resident_end - $$) + 0x100 + 15) >> 4
        mov     ax, 0x3100
        int     0x21

msg:    db 'KEYSPY: watching INT 15h AH=4Fh', 13, 10, '$'

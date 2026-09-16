; wxprobe.com - is WXP's control interface (INT 6Ch) actually there?
;
; wxpdosv toggles the FEP with:
;     mov ax,4C00h / int 6Ch      -> AL = current state
;     mov ah,00h / mov al,0|1 / int 6Ch
; so before building anything on that, check the vector exists and that the
; query call returns rather than wandering off.

        bits 16
        org 0x100

start:
        mov     dx, msg_vec
        call    puts

        xor     ax, ax
        mov     es, ax
        mov     bx, 0x6c * 4
        mov     ax, [es:bx + 2]         ; vector segment
        mov     si, ax                  ; keep it to decide whether to call
        call    puthex16
        mov     dl, ':'
        call    putc
        mov     ax, [es:bx]             ; vector offset
        call    puthex16
        call    crlf

        or      si, si
        jnz     .do_call
        mov     dx, msg_novec
        call    puts
        jmp     .done

.do_call:
        mov     dx, msg_call
        call    puts
        mov     ax, 0x4c00
        int     0x6c
        push    ax
        mov     dx, msg_ret
        call    puts
        pop     ax
        call    puthex16
        call    crlf

.done:
        mov     ax, 0x4c00
        int     0x21

; ---------------------------------------------------------------- helpers

puts:
        mov     ah, 9
        int     0x21
        ret

putc:
        mov     ah, 2
        int     0x21
        ret

crlf:
        mov     dl, 13
        call    putc
        mov     dl, 10
        call    putc
        ret

puthex16:
        push    ax
        mov     al, ah
        call    puthex8
        pop     ax
        call    puthex8
        ret

puthex8:
        push    ax
        shr     al, 4
        call    puthex4
        pop     ax
        and     al, 0x0f
        call    puthex4
        ret

puthex4:
        add     al, '0'
        cmp     al, '9'
        jbe     .ok
        add     al, 7
.ok:
        mov     dl, al
        jmp     putc

msg_vec:    db 'INT 6C vector = $'
msg_novec:  db 'vector is null, not calling', 13, 10, '$'
msg_call:   db 'calling AX=4C00h INT 6Ch ... $'
msg_ret:    db 'returned AX=$'

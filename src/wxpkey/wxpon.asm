; WXPON.COM - can WXP be switched on at all under DOSBox-X?
;
; WXPROBE showed the query (AX=4C00h, INT 6Ch) returns cleanly. This does the
; other half - the set (AH=00h, AL=01h) - from a plain program, with a marker
; printed before and after, so a screenshot says exactly where it stopped.

        bits 16
        org 0x100

start:
        mov     dx, msg_before
        mov     ah, 9
        int     0x21

        mov     ah, 0x00
        mov     al, 0x01
        int     0x6c                    ; turn the FEP on

        mov     dx, msg_after
        mov     ah, 9
        int     0x21

        ; Read it back to see whether it stuck.
        mov     ax, 0x4c00
        int     0x6c
        add     al, '0'
        mov     dl, al
        mov     ah, 2
        int     0x21

        mov     dx, msg_crlf
        mov     ah, 9
        int     0x21

        mov     ax, 0x4c00
        int     0x21

msg_before: db 'before set$'
msg_after:  db ' / after set, state=$'
msg_crlf:   db 13, 10, '$'

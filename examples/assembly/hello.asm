; hello.asm — a Windows x64 NASM program for OpenMind Studio's Run Code.
;
; Run Code assembles it with NASM (-f win64), links it with the MinGW-w64 gcc of the Assembly runtime and runs it.
; It prints a greeting, then every command-line argument (Run > Run Code with Arguments...), and exits with the
; number of arguments, so the exit code shows in the Output too.

        default rel
        global  main
        extern  printf

        section .data
greeting:   db "Hello from NASM on Windows x64!", 10, 0
count_fmt:  db "Arguments: %d", 10, 0
arg_fmt:    db "  [%d] %s", 10, 0

        section .text
main:
        ; Windows x64 calling convention: argc in ecx, argv in rdx; 32 bytes of shadow space for callees.
        push    rbx
        push    rsi
        push    rdi
        sub     rsp, 32

        mov     ebx, ecx                ; argc (includes the program itself)
        mov     rsi, rdx                ; argv

        lea     rcx, [greeting]
        call    printf

        lea     rcx, [count_fmt]
        lea     edx, [rbx - 1]          ; arguments after the program name
        call    printf

        mov     edi, 1                  ; argv[1] is the first argument
.next:
        cmp     edi, ebx
        jge     .done
        lea     rcx, [arg_fmt]
        mov     edx, edi
        mov     r8, [rsi + rdi*8]
        call    printf
        inc     edi
        jmp     .next

.done:
        lea     eax, [rbx - 1]          ; exit code = number of arguments
        add     rsp, 32
        pop     rdi
        pop     rsi
        pop     rbx
        ret

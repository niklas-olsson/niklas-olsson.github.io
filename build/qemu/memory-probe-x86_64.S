/* SPDX-License-Identifier: Apache-2.0 */
/* Linux x86_64 validation fixture. Run inside the guest, never on the host.
 * Allocate 1152 MiB, dirty every page with a distinct value, verify every page,
 * report /proc/self/status while resident, unmap, then emit a completion marker.
 * No libc, dynamic loader, network, privilege changes or persistent writes.
 */
.equ ALLOCATION_BYTES, 1207959552
.equ PAGE_COUNT, 294912
.section .text
.global _start
_start:
    mov $9, %eax
    xor %edi, %edi
    mov $ALLOCATION_BYTES, %esi
    mov $3, %edx
    mov $0x22, %r10d
    mov $-1, %r8
    xor %r9d, %r9d
    syscall
    cmp $-4095, %rax
    jae fail_map
    mov %rax, %r12
    mov %rax, %rdi
    xor %r13d, %r13d
write_pages:
    mov %r13d, %eax
    xor $0x5a5aa5a5, %eax
    mov %eax, (%rdi)
    add $4096, %rdi
    inc %r13d
    cmp $PAGE_COUNT, %r13d
    jb write_pages
    mov %r12, %rdi
    xor %r13d, %r13d
read_pages:
    mov %r13d, %eax
    xor $0x5a5aa5a5, %eax
    cmp %eax, (%rdi)
    jne fail_memory
    add $4096, %rdi
    inc %r13d
    cmp $PAGE_COUNT, %r13d
    jb read_pages
    /* Observe the guest's resident peak before munmap. */
    mov $257, %eax
    mov $-100, %rdi
    lea status_path(%rip), %rsi
    xor %edx, %edx
    xor %r10d, %r10d
    syscall
    test %rax, %rax
    js fail_status
    mov %rax, %r15
    xor %eax, %eax
    mov %r15, %rdi
    lea status_buffer(%rip), %rsi
    mov $4096, %edx
    syscall
    test %rax, %rax
    jle fail_status
    mov %rax, %rbx
    mov $1, %eax
    mov $1, %edi
    lea status_buffer(%rip), %rsi
    mov %rbx, %rdx
    syscall
    cmp %rbx, %rax
    jne fail_status
    mov $3, %eax
    mov %r15, %rdi
    syscall
    mov $11, %eax
    mov %r12, %rdi
    mov $ALLOCATION_BYTES, %esi
    syscall
    test %rax, %rax
    jne fail_unmap
    mov $1, %eax
    mov $1, %edi
    lea success(%rip), %rsi
    mov $(success_end-success), %edx
    syscall
    cmp $(success_end-success), %rax
    jne fail_status
    xor %edi, %edi
    jmp exit
fail_map:
    mov $2, %edi
    jmp fail
fail_memory:
    mov $3, %edi
    jmp fail
fail_unmap:
    mov $4, %edi
    jmp fail
fail_status:
    mov $5, %edi
fail:
    mov %edi, %r14d
    mov $1, %eax
    mov $2, %edi
    lea failure(%rip), %rsi
    mov $(failure_end-failure), %edx
    syscall
    mov %r14d, %edi
exit:
    mov $60, %eax
    syscall
    ud2
.section .rodata
status_path: .asciz "/proc/self/status"
success: .ascii "TERRARIUM_MEMORY_PROBE_OK allocated_bytes=1207959552 verified_pages=294912 page_bytes=4096\n"
success_end:
failure: .ascii "TERRARIUM_MEMORY_PROBE_FAIL\n"
failure_end:
.section .bss
.balign 16
status_buffer: .skip 4096
.section .note.GNU-stack,"",@progbits

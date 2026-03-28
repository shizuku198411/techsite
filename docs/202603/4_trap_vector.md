---
title: カーネル開発 #4 trapベクタの実装
date: 2026-03-28 22:20:00
excerpt: stvec の設定、trap_entry の実装、sscratch 用 scratch 構造体を使った退避処理を整える
tags: kernel, riscv32, trap, exception, stvec
---

## はじめに

この記事では、RISC-V の trap 処理のベース実装を進めます。

ここまでで、ブート処理、文字出力、`.bss` の初期化までは整っていました。ただし、例外や割り込みが発生したときに、どこへ制御を移し、どのスタック上でレジスタを退避し、どう復帰するかはまだ十分に整理できていませんでした。

そこで今回は、`stvec` の設定、`trap_entry` の実装、`handle_trap()` による原因ごとのディスパッチに加えて、`sscratch` 用の scratch 構造体を使った退避処理を導入しました。

今回実装した内容は次の通りです。

- `stvec` に trap ベクタを設定する
- `trap_entry` でレジスタを退避する
- `sscratch` 用の scratch 構造体を用意し、U-Mode/S-Mode の違いに応じて適切な `sp` を選ぶ
- `handle_trap()` で `scause` / `stval` / `sepc` を読み取り、原因ごとに処理を分ける

## 全体の流れ

今回の trap 処理の流れを大まかに書くと、次のようになります。

1. ブートストラップ中に `stvec` へ `trap_entry` を設定する
2. 同じくブートストラップ中に `trap_scratch` を初期化し、`sscratch` に設定する
3. trap 発生時に `trap_entry` へ制御が移る
4. `trap_entry` で scratch 領域へ一時退避しつつ、必要なら `sp` を kernel stack へ切り替える
5. kernel stack 上へ trap frame を構築する
6. `handle_trap()` で `scause` などを読み取り、例外や割り込みごとに処理を分ける
7. 例外や割り込みの種別に応じて処理を分ける

いまはまだ scheduler や syscall までは入っていませんが、trap から安全に戻れる土台はここで整います。

## trap ベクタの設定

まず、ブートストラップ中に `stvec` へ trap 入口アドレスを設定しています。

```c
static void boostrap_trap_vector(void) {
    printf("[boot] set trap vector\n");
    WRITE_CSR(stvec, (uint32_t) trap_entry);
    printf("[boot]   stvec: %p\n", READ_CSR(stvec));
}
```

この処理は `kernel_bootstrap()` の中から呼び出しています。

```c
static void kernel_bootstrap(void) {
    bootstrap_memory();
    boostrap_trap_vector();
}
```

これにより、以後 S-mode で trap が発生した場合は `trap_entry` へ飛ぶようになります。

### なぜブート時に設定するのか

trap ベクタは、例外や割り込みが発生したときの最初の入口です。そのため、初期化の早い段階で設定しておかないと、想定外の例外が起きたときに原因不明の停止になりやすくなります。

今の段階では、まだ「受けた後に止まるだけ」でも十分価値があります。まずは例外や割り込みを観測できる状態を作ることが重要です。

## trap_frame と trap_scratch の定義

退避対象を整理するために、ヘッダ側では trap フレーム構造体を定義しています。

```c
struct trap_frame {
    uint32_t ra;
    uint32_t gp;
    uint32_t tp;
    uint32_t t0;
    uint32_t t1;
    uint32_t t2;
    uint32_t t3;
    uint32_t t4;
    uint32_t t5;
    uint32_t t6;
    uint32_t a0;
    uint32_t a1;
    uint32_t a2;
    uint32_t a3;
    uint32_t a4;
    uint32_t a5;
    uint32_t a6;
    uint32_t a7;
    uint32_t s0;
    uint32_t s1;
    uint32_t s2;
    uint32_t s3;
    uint32_t s4;
    uint32_t s5;
    uint32_t s6;
    uint32_t s7;
    uint32_t s8;
    uint32_t s9;
    uint32_t s10;
    uint32_t s11;
    uint32_t sp;
} __attribute__((packed));
```

また、trap 入口の最初の数命令で使う一時領域として、`trap_scratch` も定義しました。

```c
struct trap_scratch {
    uint32_t save_t0;
    uint32_t save_t1;
    uint32_t save_t2;
    uint32_t save_sp;
    uint32_t kernel_sp;
};
```

これは、trap 入口ではまだ通常の stack を安全に使えるとは限らないためです。特に U-Mode から trap が発生した場合、`sp` は user stack を指している可能性があります。その状態でいきなりレジスタ退避を始めるのは安全ではありません。

そのため、最初の分岐に必要な情報だけは `sscratch` が指す scratch 構造体へ退避し、その後で kernel stack 上へ本格的な trap frame を構築する形としています。

## trap_scratch の初期化

`trap_scratch` はブート時に初期化しています。

```c
void kernel_bootstrap(void) {
    /* ... */
    uint32_t kernel_sp;
    __asm__ __volatile__("mv %0, sp" : "=r"(kernel_sp));
    trap_init_scratch(kernel_sp);
}
```

`trap_init_scratch()` では、`kernel_sp` を scratch 構造体へ保存し、さらに `sscratch` にそのアドレスを書き込みます。

```c
void trap_init_scratch(uint32_t kernel_sp) {
    boot_trap_scratch.save_t0 = 0;
    boot_trap_scratch.save_t1 = 0;
    boot_trap_scratch.save_t2 = 0;
    boot_trap_scratch.save_sp = 0;
    boot_trap_scratch.kernel_sp = kernel_sp;
    WRITE_CSR(sscratch, (uint32_t)&boot_trap_scratch);
}
```

今の段階では単一の kernel stack しか持っていないため、`boot_trap_scratch` を 1 つ用意すれば十分です。タイマ割り込みの有効化自体は次の記事で扱いますが、trap に備えた scratch の準備はここで済ませています。

## trap_entry の実装

trap の最初の入口は `trap_entry` として実装しています。

```c
__attribute__((section(".text.trap_entry")))
__attribute__((naked))
__attribute__((aligned(4)))
void trap_entry(void) {
    __asm__ __volatile__(
        /* ... */
    );
}
```

### `.text.trap_entry` に置く理由

リンカスクリプトでは、trap 入口用に `.text.trap_entry` を個別に保持しています。

```ld
.text : {
    KEEP(*(.text.boot_entry));
    KEEP(*(.text.trap_entry));
    *(.text .text.*);
}
```

これにより、trap 入口が最適化やリンク時に消されず、意図した位置へ必ず配置されるようになります。

### `naked` を付ける理由

trap 入口では、通常の C 関数プロローグに頼らず、自分でレジスタ退避やスタック操作を行う必要があります。そのため `naked` を付けて、最初の処理を完全にアセンブリで制御しています。

## `sscratch` と `sp` の扱い

今回の実装では、`sscratch` は「kernel stack の値そのもの」ではなく、「trap 入口専用の scratch 構造体へのポインタ」として使っています。

trap 入口の先頭では、まず `a0` と `sscratch` を入れ替え、`a0` に `trap_scratch` へのポインタを取り出します。

```asm
"csrrw a0, sscratch, a0\n"
"sw t0,  4 * 0(a0)\n"
"sw t1,  4 * 1(a0)\n"
"sw t2,  4 * 2(a0)\n"
"sw sp,  4 * 3(a0)\n"
```

これにより、`t0`-`t2` と元の `sp` を、まだ stack を使わずに安全な領域へ退避できます。

その後、`sstatus.SPP` を見て trap 発生元を判定します。

```asm
"csrr t0, sstatus\n"
"andi t0, t0, 0x100\n"
"bnez t0, 1f\n"
"lw sp,  4 * 4(a0)\n"
"1:\n"
```

ここでは、

- U-Mode からの trap なら `sp = trap_scratch.kernel_sp`
- S-Mode からの trap なら現在の `sp` をそのまま使う

という方針にしています。

### なぜ scratch 構造体が必要なのか

RISC-V の `t0`-`t2` は temporary register ですが、これは「関数呼び出し規約上、callee が保存義務を持たない」という意味です。timer 割り込みのような非同期 trap では、割り込まれた側にとっては `t0`-`t2` も含めてすべてのレジスタがまだ生きている可能性があります。

そのため、trap 入口で `SPP` 判定のために `t0` を勝手に壊してしまうのは安全ではありません。

今回のように `trap_scratch` を導入しておくと、まだ stack を触りたくない段階でも最初の数レジスタを一時退避でき、U-Mode/S-Mode の判定後に安全な kernel stack 上へ移れるようになります。

### U-Mode と S-Mode の違い

U-Mode から trap が発生した場合、`sp` は user stack を指しています。このまま退避処理を始めると、カーネルが user stack 上へレジスタを書き込むことになります。

```text
U-mode trap 発生直後

  user stack
  +----------------------+
  | user local data      |
  | return address etc.  |
  +----------------------+
            ^
            |
           sp

  trap_scratch
  +----------------------+
  | save_t0              |
  | save_t1              |
  | save_t2              |
  | save_sp              |
  | kernel_sp            |
  +----------------------+
            ^
            |
        sscratch
```

一方、S-Mode から trap が発生した場合は、`sp` はすでに kernel stack を指しています。この場合はわざわざ切り替える必要はありません。

```text
S-mode trap 発生直後

  kernel stack
  +----------------------+
  | current kernel frame |
  | local data           |
  +----------------------+
            ^
            |
           sp

  trap_scratch
  +----------------------+
  | save_t0              |
  | save_t1              |
  | save_t2              |
  | save_sp              |
  | kernel_sp            |
  +----------------------+
            ^
            |
        sscratch
```

この違いがあるため、trap 入口では「いまの `sp` がどの stack を指しているか」を見て、必要なときだけ kernel stack へ切り替える必要があります。

## kernel stack 上への trap frame 構築

`SPP` 判定が終わったら、kernel stack 上へ trap frame を構築します。

```asm
"addi sp, sp, -4 * 32\n"
"sw ra,  4 * 0(sp)\n"
"sw gp,  4 * 1(sp)\n"
"sw tp,  4 * 2(sp)\n"

"lw t0,  4 * 0(a0)\n"
"lw t1,  4 * 1(a0)\n"
"lw t2,  4 * 2(a0)\n"
"sw t0,  4 * 3(sp)\n"
"sw t1,  4 * 4(sp)\n"
"sw t2,  4 * 5(sp)\n"
```

ここでは、先に scratch へ逃がしておいた `t0`-`t2` を読み戻して trap frame に格納しています。

また、`a0` の元の値は `csrrw a0, sscratch, a0` によって一時的に `sscratch` へ退避されているため、それも後で trap frame に保存しています。

```asm
"csrr t0, sscratch\n"
"sw t0,  4 * 10(sp)\n"
```

元の `sp` は `trap_scratch.save_sp` から取り出して trap frame へ保存します。

```asm
"lw t0,  4 * 3(a0)\n"
"sw t0,  4 * 30(sp)\n"
```

このようにして、「最初の scratch 退避」と「最終的な trap frame への保存」を二段階に分けています。

## handle_trap による原因判別

trap の本体処理は `handle_trap()` に分けています。

```c
void handle_trap(void) {
    uint32_t scause  = READ_CSR(scause);
    uint32_t stval   = READ_CSR(stval);
    uint32_t user_pc = READ_CSR(sepc);
    uint32_t sstatus = READ_CSR(sstatus);

    bool from_user = (sstatus & (1u << 8)) == 0;
    (void)from_user;

    switch (scause) {
        case SCAUSE_INSTRUCTION_ACCESS_FAULT:
            PANIC("Instruction access fault. scause=%x, stval=%x, sepc=%x\n", scause, stval, user_pc);
            __builtin_unreachable();

        default:
            PANIC("Unexpected trap. scause=%x, stval=%x, sepc=%x\n", scause, stval, user_pc);
            __builtin_unreachable();
    }
}
```

実際のコードでは、命令アドレス不整列、違法命令、アクセスフォルト、ページフォルト、`ecall`、タイマ割り込みなど、複数の `scause` を定義して分岐させています。

### 今は panic に寄せる方針

現時点では、予期しない trap は基本的に `PANIC` へつなげています。

これはまだ trap を「回復」したり「処理継続」したりする段階ではなく、まずは何が起きたかを正しく観測することを優先しているためです。

この方針には次の利点があります。

- 予期しない例外をその場で発見できる
- `scause`, `stval`, `sepc` をそのまま観測できる
- 不正な状態でカーネルを進めずに済む

## 動作確認

起動時には、まず `stvec` を表示して trap ベクタが正しく設定されていることを確認します。

```text
[boot] set trap vector
[boot]   stvec: 0x80200014
```

`stvec` には `0x80200014` がセットされています。`llvm-objdump` を利用して、このアドレスにどの関数が配置されているか確認してみます。

```bash
$ llvm-objdump -d bin/kernel.elf | head -n 20

bin/kernel.elf: file format elf32-littleriscv

Disassembly of section .text:

    :

80200014 <trap_entry>:
80200014: 73 15 05 14   csrrw   a0, sscratch, a0
80200018: 23 20 55 00   sw      t0, 0(a0)
8020001c: 23 22 65 00   sw      t1, 4(a0)
80200020: 23 24 75 00   sw      t2, 8(a0)
80200024: 23 26 15 00   sw      sp, 12(a0)
```

`0x80200014` には `trap_entry` が配置されていることが分かります。これにより、trap 発生時には `trap_entry` へ制御が移る土台が整っていることを確認できます。

次に、明示的に trap を発生させて `handle_trap()` まで到達できるか確認します。今回は `kernel_main()` で一時的に `unimp` 命令を実行しました。

```c
void kernel_main(void) {
    kernel_bootstrap();
    __asm__ __volatile__("unimp");

    for (;;) {
        __asm__ __volatile__("wfi");
    }
}
```

`unimp` は違法命令として扱われるため、`scause = Illegal instruction (0x02)` の経路へ入ります。

```text
PANIC: src/kernel/trap/trap_handle.c:124: Illegal instruction. scause=00000002, stval=00000000, sepc=802001b4
```

このときの `sepc` も `llvm-objdump` で確認してみます。

```bash
$ llvm-objdump -d bin/kernel.elf | sed -n '70,90p'

802001a8 <kernel_main>:
    :
802001b4: 00 00         unimp
802001b6: 73 00 50 10   wfi
    :
```

`unimp` を実行した位置で trap が発生し、`handle_trap()` まで到達していることが確認できました。

この確認により、少なくとも次の点を確認できています。

- `stvec` が正しく設定されていること
- `trap_entry` へ制御が移ること
- `trap_scratch` を使って U-Mode/S-Mode を判別できること
- kernel stack 上へ trap frame を構築できること

## まとめ

今回は、`stvec` の設定、`trap_entry` によるレジスタ退避、`trap_scratch` を使った `sscratch` の運用、`handle_trap()` による原因判別までを実装しました。

単に例外を panic で止めるだけでなく、「trap 入口でどの stack を使うか」「最初の数命令でどこへ退避するか」を整理できたことで、今後 scheduler や syscall を実装するための基盤がかなり安定してきました。

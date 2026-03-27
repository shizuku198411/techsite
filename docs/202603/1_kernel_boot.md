---
title: カーネル開発 #1 ブート処理と kernel_main までの流れ
date: 2026-03-26
excerpt: リンカスクリプトの配置から初期スタックの設定、kernel_main へ制御が移るまでを整理する
tags: kernel, riscv32, boot, linker
---

## はじめに

この記事では、RISC-V 32bit 向けに実装している自作カーネルについて、起動直後の最小ブート処理をまとめます。

今回は次の流れで実装していきます。

- リンカスクリプトでカーネルの配置アドレスを決める
- ブートエントリで初期スタックを設定する
- `kernel_main` にジャンプしてC側の処理へ移る

まだ割り込み処理やメモリ初期化は入っていませんが、カーネルとして最初に必要になる骨格はここで一通り揃います。

> ソースコードは以下リポジトリで公開しています。
> [GitHub: drizzle](https://github.com/shizuku198411/drizzle)

## 全体の流れ

今回のブート処理の流れを大まかに書くと、次のようになります。

1. リンカスクリプトでカーネルの開始アドレスと各セクションの配置を定義する
2. `ENTRY` により最初に実行される関数を決める
3. `boot_entry` で `sp` をカーネル用スタックの先頭へ設定する
4. `kernel_main` にジャンプする

この構成にしておくと、ブート直後に必要な処理だけを小さく保ったまま、後から trap 処理やページテーブル初期化を追加しやすくなります。

## リンカスクリプト

まず、カーネルの配置はリンカスクリプトで定義しています。

```ld
ENTRY(boot_entry)

SECTIONS {
    /* kernel start address = 0x80200000 */
    . = 0x80200000;
    __kernel_start_addr = .;

    .text : {
        KEEP(*(.text.boot_entry));
        KEEP(*(.text.trap_entry));
        *(.text .text.*);
    }

    .rodata : ALIGN(4) {
        *(.rodata .rodata.* .srodata .srodata.*);
    }

    .data : ALIGN(4) {
        *(.data .data.* .sdata .sdata.*);
    }

    .bss : ALIGN(4) {
        __bss_start_addr = .;
        *(.bss .bss.* .sbss .sbss.*);
        *(COMMON);
        __bss_end_addr = .;
    }

    __kernel_end_addr = ALIGN(16);

    .kstack (NOLOAD) : ALIGN(16) {
        . = ALIGN(16);
        . += 64 * 1024;
        __stack_top_addr = .;
    }

    /* 64MB free ram */
    . = ALIGN(4096);
    .fram (NOLOAD) : ALIGN(4096) {
        __free_ram_start_addr = .;
        . += 64 * 1024 * 1024;
        __free_ram_end_addr = .;
    }
}
```

この設定では、カーネル全体を `0x80200000` から配置し、最初に実行されるエントリポイントとして `boot_entry` を指定しています。また、コード、読み取り専用データ、初期化済みデータ、未初期化データ、カーネルスタック、free ram を順番に並べています。

### `.text` セクション

`.text.boot_entry` を `KEEP` しているのは、最適化やリンク時にブートエントリが消されないようにするためです。

また、将来的な trap 処理のために `.text.trap_entry` も確保しています。現時点ではまだ本格的に使っていませんが、後続実装を見据えた構成にしています。

### `.bss` とカーネル終端

未初期化変数用の `.bss` には、開始・終了位置を表すシンボルを置いています。

```ld
.bss : ALIGN(4) {
    __bss_start_addr = .;
    *(.bss .bss.* .sbss .sbss.*);
    *(COMMON);
    __bss_end_addr = .;
}

__kernel_end_addr = ALIGN(16);
```

今はまだ `.bss` のクリア処理を実装していませんが、後でメモリ初期化を入れるときに必要になります。

### スタック領域

カーネルの初期スタックは、専用の `NOLOAD` セクションとして確保しています。

```ld
.kstack (NOLOAD) : ALIGN(16) {
    . = ALIGN(16);
    . += 64 * 1024;
    __stack_top_addr = .;
}
```

ここでは 64 KiB のスタックを確保し、その上端を `__stack_top_addr` として公開しています。

RISC-V ではC関数へ入る時点でスタックが 16 byte 境界に揃っていることが重要です。そのため、`ALIGN(16)` を使っています。

### free ram の定義

スタック領域の後ろには、free ram として使うための領域も定義しています。

```ld
/* 64MB free ram */
. = ALIGN(4096);
.fram (NOLOAD) : ALIGN(4096) {
    __free_ram_start_addr = .;
    . += 64 * 1024 * 1024;
    __free_ram_end_addr = .;
}
```

ここでは 4 KiB 境界に揃えた位置から、64 MiB 分を free ram として予約しています。

開始位置を `__free_ram_start_addr`、終了位置を `__free_ram_end_addr` としてシンボル化しているため、今後ページアロケータや簡易ヒープを実装する際に、この範囲をそのまま利用できます。

また、`.fram` には `NOLOAD` を付けています。これにより、この領域は ELF ファイル内に実データとして書き込まれず、「実行時に使うための予約領域」として扱えます。

## boot_entry の実装

次に、実際に最初に実行される `boot_entry` を見ていきます。

```c
extern char __stack_top_addr[];

__attribute__((section(".text.boot_entry")))
__attribute__((naked))
void boot_entry(void) {
    __asm__ __volatile__(
        "mv sp, %[stack_top_addr]\n"
        "csrw sscratch, sp\n"
        "j kernel_main\n"
        :
        : [stack_top_addr] "r" (__stack_top_addr)
    );
}
```

### `naked` を付ける理由

`boot_entry` には `__attribute__((naked))` を付けています。これは、コンパイラによる通常の関数プロローグ・エピローグを生成させないためです。

ブート直後はまだスタックが初期化されていないため、通常の C 関数として扱わせるのは危険です。そのため、最初の数命令は自前のアセンブリで明示的に制御します。

### `sp` の初期化

最初の命令では、リンカスクリプトで定義した `__stack_top_addr` を `sp` に設定しています。

これによって、以降の C コードが使うスタック領域が初めて有効になります。

### `sscratch` への保存

`csrw sscratch, sp` で、現在のスタックポインタを `sscratch` に保存しています。

現時点ではまだ trap 処理を実装していませんが、後で例外・割り込み処理を入れる際に、カーネルスタックの退避先として使いやすくなります。

### `kernel_main` へのジャンプ

最後に `j kernel_main` で C 側のメイン処理へ移ります。

ここでは関数呼び出しではなくジャンプにしているため、ブートコードをなるべく単純に保てます。

## kernel_main の現在の状態

現時点の `kernel_main` は、最小確認用として非常に単純な実装になっています。

```c
void kernel_main(void) {
    __asm__ __volatile__("wfi");
}
```

`wfi` は Wait For Interrupt 命令であり、ここでは「C のエントリポイントまで正常に到達できた」ことを確認するための仮実装として置いています。

今後はここから、

- `.bss` の初期化
- trap ベクタの設定
- UART 出力
- メモリ管理の初期化

といった処理を順に追加していく予定です。

## 動作確認
ここまでの実装で、実際にQemuを利用して起動してみます。

```bash
$ make build
clang -std=c11 -O2 -g3 -Wall -Wextra --target=riscv32-unknown-elf -fuse-ld=lld -fno-stack-protector -ffreestanding -nostdlib -Isrc/kernel/include -Wl,-Tsrc/kernel/kernel.ld -Wl,-Map=map/kernel.map -o bin/kernel.elf \
        src/kernel/*.c

$ make qemu-start
qemu-system-riscv32 -machine virt -bios default -nographic -serial mon:stdio --no-reboot -kernel bin/kernel.elf

OpenSBI v1.2
   ____                    _____ ____ _____
  / __ \                  / ____|  _ \_   _|
 | |  | |_ __   ___ _ __ | (___ | |_) || |
 | |  | | '_ \ / _ \ '_ \ \___ \|  _ < | |
 | |__| | |_) |  __/ | | |____) | |_) || |_
  \____/| .__/ \___|_| |_|_____/|____/_____|
        | |
        |_|

Platform Name             : riscv-virtio,qemu
Platform Features         : medeleg
Platform HART Count       : 1
Platform IPI Device       : aclint-mswi
Platform Timer Device     : aclint-mtimer @ 10000000Hz
Platform Console Device   : uart8250
Platform HSM Device       : ---
Platform PMU Device       : ---
Platform Reboot Device    : sifive_test
Platform Shutdown Device  : sifive_test
Firmware Base             : 0x80000000
Firmware Size             : 208 KB
Runtime SBI Version       : 1.0

Domain0 Name              : root
Domain0 Boot HART         : 0
Domain0 HARTs             : 0*
Domain0 Region00          : 0x02000000-0x0200ffff (I)
Domain0 Region01          : 0x80000000-0x8003ffff ()
Domain0 Region02          : 0x00000000-0xffffffff (R,W,X)
Domain0 Next Address      : 0x80200000
Domain0 Next Arg1         : 0x87e00000
Domain0 Next Mode         : S-mode
Domain0 SysReset          : yes

Boot HART ID              : 0
Boot HART Domain          : root
Boot HART Priv Version    : v1.12
Boot HART Base ISA        : rv32imafdch
Boot HART ISA Extensions  : time,sstc
Boot HART PMP Count       : 16
Boot HART PMP Granularity : 4
Boot HART PMP Address Bits: 32
Boot HART MHPM Count      : 16
Boot HART MIDELEG         : 0x00001666
Boot HART MEDELEG         : 0x00f0b509

```

今回の実装ではブート後にwfi≒無限ループとしているため、表示上の変化はありません。
そこで、qemu monitorを利用してレジスタの情報を確認してみます。

```text
QEMU 8.2.2 monitor - type 'help' for more information
(qemu) stop
(qemu) info registers 

CPU#0
 V      =   0
 pc       80200016
 mhartid  00000000
 mstatus  80006080
 mstatush 00000000
 hstatus  00000000
 vsstatus 00000000
 mip      00000000
 mie      00000008
 mideleg  00001666
 hideleg  00000000
 medeleg  00f0b509
 hedeleg  00000000
 mtvec    80000530
 stvec    80200000
 vstvec   00000000
 mepc     80200000
 sepc     00000000
 vsepc    00000000
 mcause   00000003
 scause   00000000
 vscause  00000000
 mtval    00000000
 stval    00000000
 htval    00000000
 mtval2   00000000
 mscratch 80033000
 sscratch 80210020
 satp     00000000
 x0/zero  00000000 x1/ra    8000a084 x2/sp    80210020 x3/gp    00000000
 x4/tp    80033000 x5/t0    00000001 x6/t1    00000002 x7/t2    00000000
 x8/s0    80032f50 x9/s1    00000001 x10/a0   80210020 x11/a1   87e00000
 x12/a2   00000007 x13/a3   00000019 x14/a4   00000000 x15/a5   00000001
 x16/a6   00000001 x17/a7   00000005 x18/s2   80200000 x19/s3   00000000
 x20/s4   87e00000 x21/s5   00000000 x22/s6   80006800 x23/s7   8001c020
 x24/s8   00002000 x25/s9   8002b4e4 x26/s10  00000000 x27/s11  00000000
 x28/t3   616d6569 x29/t4   8001a5a1 x30/t5   000000c8 x31/t6   00000000
 f0/ft0   ffffffff00000000 f1/ft1   ffffffff00000000 f2/ft2   ffffffff00000000 f3/ft3   ffffffff00000000
 f4/ft4   ffffffff00000000 f5/ft5   ffffffff00000000 f6/ft6   ffffffff00000000 f7/ft7   ffffffff00000000
 f8/fs0   ffffffff00000000 f9/fs1   ffffffff00000000 f10/fa0  ffffffff00000000 f11/fa1  ffffffff00000000
 f12/fa2  ffffffff00000000 f13/fa3  ffffffff00000000 f14/fa4  ffffffff00000000 f15/fa5  ffffffff00000000
 f16/fa6  ffffffff00000000 f17/fa7  ffffffff00000000 f18/fs2  ffffffff00000000 f19/fs3  ffffffff00000000
 f20/fs4  ffffffff00000000 f21/fs5  ffffffff00000000 f22/fs6  ffffffff00000000 f23/fs7  ffffffff00000000
 f24/fs8  ffffffff00000000 f25/fs9  ffffffff00000000 f26/fs10 ffffffff00000000 f27/fs11 ffffffff00000000
 f28/ft8  ffffffff00000000 f29/ft9  ffffffff00000000 f30/ft10 ffffffff00000000 f31/ft11 ffffffff00000000
```

ポイントは `pc` レジスタ、現在の実行アドレスが保存されているレジスタです。
pc = 0x80200016 となっているので、実際のカーネルバイナリ(elf)と比較してみます。

```bash
$ llvm-objdump -d bin/kernel.elf 

bin/kernel.elf: file format elf32-littleriscv

Disassembly of section .text:

80200000 <boot_entry>:
80200000: 37 05 21 80   lui     a0, 0x80210
80200004: 13 05 05 02   addi    a0, a0, 0x20
80200008: 2a 81         mv      sp, a0
8020000a: 73 10 01 14   csrw    sscratch, sp
8020000e: 6f 00 40 00   j       0x80200012 <kernel_main>

80200012 <kernel_main>:
80200012: 73 00 50 10   wfi
80200016: 82 80         ret
```

0x80200016 は、kernel_mainになっています。
表示上は変化がありませんが、正常にboot_entry→kernel_mainへの移行ができていることがわかりました。

## まとめ

今回は、リンカスクリプトの実装から始めて、初期スタックの設定を経由し、`kernel_main` に制御を移すところまでを実装しました。

まだカーネルとしての機能はほとんどありませんが、「どこに配置され、どこから始まり、どうやってCに入るか」という最初の一歩が形になりました。

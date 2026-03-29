---
title: カーネル開発 #6 U-Modeへの移行
date: 2026-03-29 11:30:00
excerpt: ユーザバイナリを固定アドレスへ配置し、sepc と user stack を設定して sret で U-Mode へ入る
tags: kernel, riscv32, usermode, sret, sepc
---

## はじめに

この記事では、これまで整えてきたブート処理と trap 処理の土台の上で、カーネルから U-Mode のユーザコードへ制御を移すところまで実装します。

前回までで、カーネルは `.bss` の初期化、trap ベクタ設定、タイマ割り込みの有効化まで進んでいました。ただし、実際にユーザ側のコードをどこへ配置し、どのように `sret` で U-Mode へ入るかはまだ未実装でした。

そこで今回は、ユーザバイナリをカーネルイメージへ埋め込み、固定アドレスへロードしたうえで、`sepc` と user stack を設定して U-Mode へ入る最小構成を実装しました。

今回実装した内容は次の通りです。

- ユーザプログラムを独立した ELF / binary として生成する
- `objcopy` で生成したユーザ binary をカーネルイメージへ埋め込む
- ブート後にユーザ binary を `USER_BASE` へコピーする
- `sepc` と `sp` を設定し、`sret` で U-Mode へ遷移する
- U-Mode からの `ecall` が trap 経由でカーネルへ戻ることを確認する

## 全体の流れ

今回の U-Mode 移行処理の流れを大まかに書くと、次のようになります。

1. ユーザプログラムを `0x80300000` 起点の独立バイナリとしてリンクする
2. その binary を `objcopy -Ibinary` でカーネルへ埋め込めるオブジェクトへ変換する
3. `kernel_main()` でブートストラップ完了後にユーザ binary を `USER_BASE` へコピーする
4. `enter_user_mode()` で `sepc = USER_BASE`、`sp = USER_STACK_TOP` を設定する
5. `sstatus` に `SPIE` を立てた状態で `sret` を実行し、U-Mode へ入る
6. ユーザ側で `ecall` などが起きたら `trap_entry` を経由してカーネルへ戻る

いまはまだ仮想メモリ切り替えやプロセス管理は入っていませんが、「S-Mode でブートしたカーネルが U-Mode のコードを起動する」という最小の流れはここで揃います。

## ユーザプログラムの配置

まず、ユーザ側のリンクアドレスは `user.ld` で固定しています。

```ld
ENTRY(user_start)

SECTIONS {
    . = 0x80300000;

    .text : ALIGN(4) {
        KEEP(*(.text.user_start));
        *(.text .text.*);
    }

    .rodata : ALIGN(4) {
        *(.rodata .rodata.*);
    }

    .data : ALIGN(4) {
        *(.data .data.*);
    }

    .bss : ALIGN(4) {
        *(.bss .bss.*);
        *(COMMON);
    }
}
```

これにより、ユーザバイナリは `0x80300000` から始まる前提で生成されます。カーネル側でも同じ値を `USER_BASE` として持っているため、ロード先とリンクアドレスが一致する形になります。

```c
#define USER_BASE      0x80300000u
#define USER_STACK_TOP 0x80310000u
```

この段階ではページテーブルによる仮想アドレス変換は行っていないため、ユーザ側のコードはカーネルが見ている物理アドレス空間上の固定位置へそのまま置いています。

## ユーザバイナリをカーネルへ埋め込む

Makefile では、ユーザプログラムをいったん独立した ELF としてリンクし、その後 binary に変換しています。

```make
$(APP_ELF): $(APP_SRCS) $(USER_SRC_DIR)/user.ld | $(BIN_DIR) $(MAP_DIR)
	$(CC) -std=c11 -O2 -g3 -Wall -Wextra --target=riscv32-unknown-elf -fuse-ld=lld -fno-stack-protector -ffreestanding -nostdlib \
		-Wl,-T$(USER_SRC_DIR)/user.ld -Wl,-Map=$(MAP_DIR)/user.map -o $@ \
		$(APP_SRCS)

$(APP_BIN): $(APP_ELF)
	$(OBJCOPY) --set-section-flags .bss=alloc,contents -O binary $< $@

$(APP_OBJ): $(APP_BIN) | $(OBJ_DIR)
	$(OBJCOPY) -Ibinary -Oelf32-littleriscv $< $@
```

最後の `$(APP_OBJ)` は、単なるバイナリファイルを「リンク可能なオブジェクト」として扱うための変換です。これにより、カーネル側から

- `_binary_bin_user_bin_start`
- `_binary_bin_user_bin_end`

というシンボル経由で埋め込まれたユーザバイナリへアクセスできるようになります。

## ユーザバイナリのロード

カーネル側では、埋め込まれたユーザバイナリを `USER_BASE` へコピーしています。

```c
extern char _binary_bin_user_bin_start[], _binary_bin_user_bin_end[];

static size_t get_user_binary_size(void) {
    return (size_t)(_binary_bin_user_bin_end - _binary_bin_user_bin_start);
}

void load_user_binary(void) {
    size_t user_size = get_user_binary_size();

    memcpy((void *)USER_BASE, _binary_bin_user_bin_start, user_size);

    printf("[boot] load user binary\n");
    printf("[boot]   user base      : %p\n", (void *)USER_BASE);
    printf("[boot]   user size      : %x\n", (unsigned)user_size);
    printf("[boot]   user stack top : %p\n", (void *)USER_STACK_TOP);
}
```

今の構成では、カーネルが持っているアドレス空間とユーザコードを置く場所が同じ実アドレス空間上にあるため、単純な `memcpy()` で十分です。

### なぜコピーが必要なのか

埋め込まれたユーザバイナリは、カーネル ELF 内の `_binary_*` シンボルとして存在しています。しかし、ユーザプログラムは `0x80300000` から始まる前提でリンクされているため、そのままでは実行開始アドレスと中身の配置が一致しません。

そのため、ブート後に一度 `USER_BASE` へコピーし、リンク時に想定したアドレスへ正しく展開してから実行します。

## `sret` による U-Mode への遷移

ユーザモード移行の本体は `enter_user_mode()` で実装しています。

```c
__attribute__((noreturn))
__attribute__((naked))
void enter_user_mode(unsigned int entry, unsigned int user_sp) {
    __asm__ __volatile__(
        "csrw sepc, a0\n"
        "mv sp, a1\n"
        "li t0, %[sstatus_spie]\n"
        "csrw sstatus, t0\n"
        "sret\n"
        :
        : [sstatus_spie] "i" (SSTATUS_SPIE)
    );
}
```

ここでやっていることは次の 4 つです。

- `sepc = entry`
  - `sret` 実行後に再開する PC を設定します
- `sp = user_sp`
  - U-Mode で使うスタックポインタへ切り替えます
- `sstatus = SSTATUS_SPIE`
  - `SPIE` のみ立てた状態を作ります
- `sret`
  - 権限レベルを戻しつつ、`sepc` のアドレスへジャンプします

### なぜ `SPIE` だけを立てるのか

RISC-V では、`sret` 実行時に `sstatus.SPP` を見て戻り先の権限レベルが決まります。`SPP = 0` なら U-Mode、`SPP = 1` なら S-Mode へ戻ります。

今回の実装では `sstatus` に `SSTATUS_SPIE` しか書いていないため、`SPP` は 0 のままです。その結果、`sret` 後は U-Mode へ入ります。

また、`SPIE` を立てておくことで、`sret` 後には `SIE` が適切に復元されます。これにより、ユーザコード実行中も timer interrupt を継続して受けられる状態になります。

### なぜ `naked` にしているのか

この関数では、通常の C 関数プロローグやエピローグを挟まず、`sp` の切り替えから `sret` までを完全に自前で制御したいからです。

もしコンパイラ任せのプロローグが入ると、切り替え前の stack を前提にレジスタ保存が行われる可能性があり、ユーザモード遷移の直前処理としては扱いづらくなります。そのため、ここでは `naked` を付けて最小限のアセンブリだけを書いています。

## `kernel_main()` からの呼び出し

U-Mode への遷移は、`kernel_main()` の末尾で行っています。

```c
void kernel_main(void) {
    kernel_bootstrap();
    load_user_binary();
    printf("[boot] enter user mode\n");
    enter_user_mode(USER_BASE, USER_STACK_TOP);
}
```

ここでは、

1. カーネルの初期化を終える
2. ユーザバイナリをメモリへ配置する
3. U-Mode へ入る

という流れになっています。

現時点では 1 つのユーザプログラムを起動するだけなので、`entry` は常に `USER_BASE`、stack は常に `USER_STACK_TOP` という固定値で十分です。

## ユーザ側の開始地点

ユーザプログラムの入口は `user_start()` にしています。

```c
void main(void);

__attribute__((section(".text.user_start")))
__attribute__((naked))
void user_start(void) {
    __asm__ __volatile__(
        "call main\n"
        "1:\n"
        "j 1b\n"
    );
}
```

リンカスクリプトでは `ENTRY(user_start)` としているため、`USER_BASE` に置かれた最初の実行地点はこの `user_start()` です。

ここでは単純に `main()` を呼び、戻ってきた場合は無限ループへ入るだけにしています。`exit()` のような終了処理はまだないため、ユーザプログラムが戻った場合の挙動を明示的に止めています。

## U-Mode から trap へ戻る流れ

現時点のユーザアプリである `shell` は、一定回数ごとに `ecall` を発行します。

```c
void main(void) {
    volatile unsigned counter = 0;

    for (;;) {
        counter++;
        if ((counter % 100000000u) == 0) {
            __asm__ __volatile__("ecall");
        }
        __asm__ __volatile__("nop");
    }
}
```

## `SCAUSE_ECALL_FROM_U_MODE` の処理変更

前回までの trap 記事時点では、`ecall` を含む例外系の trap は基本的に `PANIC` させる方針でした。

しかし、今回は実際に U-Mode のコードを動かすため、`SCAUSE_ECALL_FROM_U_MODE` については panic せずに処理して、そのままユーザ側へ復帰できるように変更しています。

```c
case SCAUSE_ECALL_FROM_U_MODE:
    printf("[trap] ecall from U-mode. scause=%x, stval=%x, sepc=%x\n", scause, stval, user_pc);
    WRITE_CSR(sepc, user_pc + 4);
    return;
```

ここでやっていることは次の 2 つです。

- `ecall` が発生したことをログへ出力する
- `sepc` を 4 byte 進めて、`ecall` 命令の次から再開する

### なぜ `sepc` を進めるのか

`ecall` は trap の原因になった命令そのものです。そのため、`sepc` を変更せずにそのまま `sret` すると、復帰後に同じ `ecall` を再実行してしまい、再び trap に入ってしまいます。

そこで、RV32 の 1 命令ぶんである 4 byte だけ `sepc` を進め、`ecall` の次の命令から再開するようにしています。

### なぜ今回は panic しないのか

今回の目的は、U-Mode のコードへ入れることに加えて、ユーザコードから発生した trap をカーネルが受けて復帰できることを確認することです。

そのため、`SCAUSE_ECALL_FROM_U_MODE` は「異常終了させるべき例外」ではなく、「ユーザ空間からカーネルへ制御を渡す入口」として扱う形に変えています。

いまの段階では syscall 番号の解釈や引数処理までは行っておらず、まずは `ecall` を安全に受けて戻せることを優先した最小実装です。

これにより、U-Mode へ入ったあとも

1. ユーザコードが実行される
2. `ecall` や timer interrupt で trap が発生する
3. `trap_entry` と `handle_trap()` を経由してカーネルへ入る
4. `sret` で再びユーザ側へ戻る

という往復が実際に起こるようになります。

前回までに整えた trap 基盤が、ここで初めて「ユーザコードを動かした結果として発生する trap」を受ける形で活きてきます。

## 動作確認

まず、U-Mode へ遷移したあとに、ユーザ側の `ecall` が継続的に trap として観測できることを確認します。

今回コンソール上で期待されるのは、`[boot] enter user mode` のあとに、一定間隔で `[trap] ecall from U-mode` のログが出力されることです。

```text
    :
[boot] enter user mode
[trap] ecall from U-mode. scause=00000008, stval=00000000, sepc=80300030
[trap] ecall from U-mode. scause=00000008, stval=00000000, sepc=80300030
[trap] ecall from U-mode. scause=00000008, stval=00000000, sepc=80300030
    :
```

期待どおり、U-Mode へ入ったあとも `ecall` による trap ログが繰り返し出力されていることが確認できました。

次に、timer interrupt についても継続的に発生していることを GDB で確認します。

```text
    :
(gdb) 
Continuing.

Hardware watchpoint 1: timer_tick_count

Old value = 124
New value = 125

(gdb) 
Continuing.
Old value = 125
New value = 126

(gdb) 
Continuing.
Old value = 126
New value = 127
    :
```

ここでは、タイマ割り込み回数を保持している `timer_tick_count` を監視しています。値が連続して増加していることから、timer interrupt も継続して発生していることがわかります。

これにより、今回の実装によって次のことが確認できました。

- U-Mode で実行中のユーザコードから `ecall` によって S-Mode へ trap できること
- `SCAUSE_ECALL_FROM_U_MODE` の処理後に、再び U-Mode 側へ復帰できること
- timer interrupt も並行して発生し、trap 基盤が継続的に動作していること

の動作が確認できました。


## 現時点の制約

今回の実装は、U-Mode へ入る最小構成としては十分ですが、まだ簡易的な点も多くあります。

- 仮想メモリは未導入で、カーネルとユーザは同じ実アドレス空間を見ている
- ユーザプログラムは 1 本だけを固定アドレスへロードしている
- ユーザ stack も固定値で、ガードページやサイズ管理はまだない
- syscall ABI やプロセス管理は未実装

つまり、いまは「U-Mode の実行を開始できること」と「trap で安全に戻ってこられること」を確認する段階です。本格的なユーザ空間分離は、今後ページテーブルや task 管理を入れていく中で整えていくことになります。

## まとめ

今回は、ユーザバイナリをカーネルへ埋め込み、`USER_BASE` へロードしたうえで、`sepc` と user stack を設定し、`sret` で U-Mode へ入るところまで実装しました。

これにより、カーネルは単にブートして trap を受けるだけでなく、実際にユーザコードを起動し、その実行結果として発生する `ecall` や timer interrupt を扱えるようになりました。

次の段階では、この仕組みを土台にして syscall の受け口や、複数タスクを見据えたコンテキスト管理へ進めるようになります。

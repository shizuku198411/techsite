---
title: カーネル開発 #5 タイマ割り込みの実装
date: 2026-03-28 23:10:00
excerpt: Supervisor Timer Interrupt を有効化し、安全な時刻取得と compare 更新を行いながら tick カウンタを進める
tags: kernel, riscv32, timer, interrupt, scheduler
---

## はじめに

この記事では、前回用意した trap ベクタの基盤の上に、Supervisor Timer Interrupt を接続します。

trap 入口でレジスタ退避と stack 切り替えができるようになったことで、今度は実際に周期的な割り込みを受けて、カーネル側で tick を進めるところまで進められるようになりました。

今回実装した内容は次の通りです。

- `sie.STIE` と `sstatus.SIE` を有効化する
- `rdtime()` で安全に現在時刻を取得する
- `stimecmp` を安全な順で更新して次回タイマを予約する
- Timer Interrupt を受けたら tick カウンタを増やす
- trap handler 内で次回タイマを再設定して復帰する

## 全体の流れ

タイマ割り込みの流れを大まかに書くと、次のようになります。

1. ブートストラップ中に trap 用 scratch を初期化する
2. `set_next_timer()` で次回発火時刻を `stimecmp` に設定する
3. `enable_timer_interrupt()` で Supervisor Timer Interrupt を有効化する
4. タイマ割り込みが発生すると `trap_entry` を経由して `handle_trap()` に入る
5. `SCAUSE_SUPERVISOR_TIMER` で tick を増やし、次回タイマを再設定する
6. `sepc` を維持したまま `sret` で復帰する

## タイマ割り込みの有効化

まず、Supervisor Timer Interrupt を有効化します。

```c
void enable_timer_interrupt(void) {
    uint32_t sie = READ_CSR(sie);
    sie |= SIE_STIE;
    WRITE_CSR(sie, sie);

    uint32_t sstatus = READ_CSR(sstatus);
    sstatus |= SSTATUS_SIE;
    WRITE_CSR(sstatus, sstatus);
}
```

ここで設定しているのは次の 2 つです。

- `sie.STIE`
  - Supervisor Timer Interrupt 自体を許可します
- `sstatus.SIE`
  - S-Mode 全体の割り込み許可を有効にします

この 2 つが揃って初めて、Supervisor Timer Interrupt を受け取れるようになります。

## 次回タイマの設定

次に、`rdtime()` で現在時刻を読み取り、`TIMER_INTERVAL` ぶん進めた時刻を `stimecmp` に設定します。

```c
static inline uint64_t rdtime(void) {
    uint32_t hi0, lo, hi1;

    do {
        __asm__ __volatile__("rdtimeh %0" : "=r"(hi0));
        __asm__ __volatile__("rdtime  %0" : "=r"(lo));
        __asm__ __volatile__("rdtimeh %0" : "=r"(hi1));
    } while (hi0 != hi1);

    return ((uint64_t)hi0 << 32) | lo;
}

static inline void wrtimecmp(uint64_t val) {
    uint32_t lo = val & 0xffffffff;
    uint32_t hi = val >> 32;

    WRITE_CSR(stimecmph, 0xffffffffu);
    WRITE_CSR(stimecmp, lo);
    WRITE_CSR(stimecmph, hi);
}

void set_next_timer() {
    uint64_t now = rdtime();
    wrtimecmp(now + TIMER_INTERVAL);
}
```

`rdtime()` は `hi -> lo -> hi` の順で 2 回上位 32bit を読み、一致するまで再試行する形にしています。これは 64bit カウンタの下位側が読み取り途中で桁上がりする可能性があるためです。

また、`wrtimecmp()` では `stimecmph` をいったん `0xffffffff` にしてから下位、最後に上位を書いています。これは RV32 で 64bit compare 値を更新する途中に、意図せず「すでに期限切れの値」に見えてしまうのを避けるためです。

## ブートストラップからの呼び出し

タイマの初期化は `kernel_bootstrap()` の一部として呼び出しています。

```c
static void bootstrap_timer(void) {
    uint32_t kernel_sp;
    __asm__ __volatile__("mv %0, sp" : "=r"(kernel_sp));
    trap_init_scratch(kernel_sp);

    set_next_timer();
    enable_timer_interrupt();

    printf("[boot] set timer\n");
    printf("[boot]   sie            : %x\n", READ_CSR(sie));
    printf("[boot]   sstatus        : %x\n", READ_CSR(sstatus));
    printf("[boot]   timer interval : %d ms\n", TIMER_INTERVAL / 10000);
}
```

ここで先に `trap_init_scratch()` を呼んでいるのは、最初の timer interrupt が来た時点で `sscratch` が有効な scratch 領域を指している必要があるためです。

また、初回の `set_next_timer()` を先に呼んでから割り込みを有効化することで、最初の期限設定前に timer interrupt が入る可能性を避けています。

## tick カウンタの追加

Timer Interrupt の確認用と、将来の scheduler 利用を見据えて、グローバルな tick カウンタを追加しました。

```c
volatile uint32_t timer_tick_count = 0;

void count_up_timer_tick(void) {
    timer_tick_count++;
}
```

`volatile` を付けているのは、通常のコードとは別に割り込みハンドラから更新される値であることをコンパイラへ伝えるためです。

今の段階では `uint32_t` で十分です。いずれオーバーフローして 0 に戻りますが、まずは tick が進み続けることの確認と、短い差分計算ができればよいため、ここでは単純な実装にしています。

## handle_trap での Timer Interrupt 処理

Timer Interrupt を受けたときは、`handle_trap()` の `SCAUSE_SUPERVISOR_TIMER` で処理します。

```c
case SCAUSE_SUPERVISOR_TIMER:
    count_up_timer_tick();
    set_next_timer();
    WRITE_CSR(sepc, user_pc);
    return;
```

ここでやっていることは 3 つです。

- `count_up_timer_tick()`
  - tick カウンタを 1 増やします
- `set_next_timer()`
  - 次回のタイマ発火時刻を再設定します
- `WRITE_CSR(sepc, user_pc)`
  - trap へ入る前の実行位置を維持したまま復帰できるようにします

タイマ割り込みは panic ではなく、今後も継続して受け続ける前提の処理です。そのため、ここでは例外系の trap とは違い、状態更新後にそのまま復帰しています。

## 動作確認

起動時のログから、timer関連のCSRが期待どおり設定されていることを確認します。

```text
[boot] set timer
[boot]   sie            : 00000020
[boot]   sstatus        : 80006002
[boot]   timer interval : 20 ms
```

ポイントとなるのは、`enable_timer_interrupt()` によって `sie` と `sstatus` の必要な bit が正しく立っているかどうかです。

今回の出力では、次の値になっていました。

- `sie = 0x00000020`
- `sstatus = 0x80006002`

### `sie` の値

`sie` は Supervisor Interrupt Enable Register で、どの種類の割り込みを受け付けるかを個別に制御します。

今回有効化したいのは `STIE` だけなので、期待値は次の通りです。

```text
sie = 0x00000020
    = 1 << 5
```

bit 5 は `STIE` で、Supervisor Timer Interrupt Enable を意味します。つまり、

- `STIE = 1`
  - Supervisor Timer Interrupt を個別に許可する

という状態です。

逆に、この bit が 0 のままだと、たとえ `stimecmp` を設定しても Supervisor Timer Interrupt は入ってきません。

### `sstatus` の値

`sstatus` は Supervisor Status Register で、S-mode 全体の実行状態や割り込み許可状態を持っています。

今回の出力は次の通りです。

```text
sstatus = 0x80006002
```

この値のうち、今回の timer 割り込みに直接関係するのは bit 1 の `SIE` です。

```text
0x80006002
         ^
         +-- bit 1 = SIE
```

- `SIE = 1`
  - S-mode 全体として割り込みを受け付ける

`sie.STIE` が「Supervisor Timer Interrupt を受けてもよい」という個別許可だとすると、`sstatus.SIE` は「そもそも S-mode で割り込み受付を有効にする」という大元の許可です。

そのため、RISC-V の仕様上は

- `sie.STIE = 1`
- `sstatus.SIE = 1`

の両方が揃って初めて、Supervisor Timer Interrupt を受けられます。

今回の `0x80006002` には bit 31 や bit 13-14 にも値が立っていますが、これらは timer 有効化処理で新たに設定した bit ではなく、起動時点ですでに入っていた状態です。今回の実装で本当に確認したいのは、`SIE` に対応する bit 1 が 1 になっていることです。

### `timer_tick_count` の監視
実装上コンソール画面上の変化がないため、実際にタイマ割り込みが発生しているかの確認をGDBを利用して確認します。

```bash
# GDB接続待機状態で起動
$ make qemu-debug

# 別コンソールでGDB接続
$ gdb-multiarch ./bin/kernel.elf
(gdb) set pagination off
(gdb) set confirm off
(gdb) set architecture riscv:rv32
The target architecture is set to "riscv:rv32".
(gdb) target remote :1234
Remote debugging using :1234
0x00001000 in ?? ()
```

これで接続ができたため、`timer_tick_count` を監視対象としてカーネルの処理を開始させます。

```bash
# `timer_tick_count` を監視対象としてセット
(gdb) watch timer_tick_count 
Hardware watchpoint 1: timer_tick_count

# 処理開始
(gdb) c
Continuing.

# 1度目のtimer_tick_count更新検知
Hardware watchpoint 1: timer_tick_count

Old value = 0
New value = 1
count_up_timer_tick () at src/kernel/timer/timer.c:48
48      }

# 処理再開
(gdb) c
Continuing.

# 2度目のtimer_tick_count更新検知
Hardware watchpoint 1: timer_tick_count

Old value = 1
New value = 2
count_up_timer_tick () at src/kernel/timer/timer.c:48
48      }
```

処理を再開させる毎に、`timer_tick_count` の値が増加していることがわかります。
つまり、正常にタイマ割り込みが発生/trap処理と復元までできていることが確認できました。

## まとめ

今回は、Supervisor Timer Interrupt の有効化、次回タイマの設定、tick カウンタの更新までを実装しました。

これにより、例外を受けて止まるだけだった trap 基盤が、「周期的に割り込みを受けてカーネル内の状態を更新する」段階まで進みました。今後 scheduler を実装する際には、この tick カウンタを time slice や sleep の基準として利用できます。

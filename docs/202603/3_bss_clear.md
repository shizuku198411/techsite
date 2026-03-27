---
title: カーネル開発 #3 .bssゼロクリア
date: 2026-03-28
excerpt: ブートストラップ処理として .bssのゼロクリア、PANIC、メモリレイアウト表示を実装する
tags: kernel, riscv32, bss, panic, memory
---

## はじめに

この記事では、ブート直後のカーネル初期化処理として、`.bss` のゼロクリアと最低限の検証処理を実装します。

前回までで、カーネルのブート処理と文字出力の仕組みは整いました。ここから先に進むためには、C が前提としているメモリ状態をきちんと用意する必要があります。特に、未初期化グローバル変数が置かれる `.bss` は、カーネル側で明示的に 0 クリアしておく必要があります。

今回実装する内容は次の通りです。

- `memset` を実装する
- `.bss` 領域を 0 クリアする
- 初期化失敗時に停止できる `PANIC` を実装する
- ブート時にメモリレイアウトを表示する

## 全体の流れ

今回のブートストラップ処理の流れを大まかに書くと、次のようになります。

1. `memset` を実装してメモリ初期化の基本関数を用意する
2. リンカスクリプトで公開した `.bss` 範囲を 0 クリアする
3. `.bss` が実際に 0 クリアされているかを検証する
4. 異常時は `PANIC` で停止する
5. 正常時はメモリレイアウトを出力する

## memset の実装

まずは、メモリ初期化の基本となる `memset` を実装します。

```c
void *memset(void *buf, int c, size_t n) {
    uint8_t *p = (uint8_t *) buf;
    while (n--) {
        *p++ = c;
    }
    return buf;
}
```

非常に単純な実装ですが、`.bss` のゼロクリアや、今後ページテーブルやバッファを初期化する際の基礎になります。

ここでは 1 byte ずつ順に値を書き込む形にしています。最適化や高速化はまだ考えず、まずは正しく動くことを優先しています。

## .bss ゼロクリアの実装

`.bss` の範囲は、リンカスクリプトで次のように公開しています。

```ld
.bss : ALIGN(4) {
    __bss_start_addr = .;
    *(.bss .bss.* .sbss .sbss.*);
    *(COMMON);
    __bss_end_addr = .;
}
```

この開始アドレスと終了アドレスを使って、ブートストラップ時に `.bss` 全体を 0 クリアします。

```c
static void clear_bss(void) {
    size_t bss_size = get_range_size(__bss_start_addr, __bss_end_addr);
    memset(__bss_start_addr, 0, bss_size);
    if (!is_zeroed(__bss_start_addr, bss_size)) {
        PANIC("bss clear failed. __bss_start_addr: %p, __bss_end_addr: %p", __bss_start_addr, __bss_end_addr);
    }
}
```

### なぜ `.bss` をクリアするのか

未初期化グローバル変数や静的変数は、C の仕様上 0 で初期化されている前提で動作します。

しかし、ベアメタルなカーネルでは、その前提を自分たちで満たさなければなりません。そのため、ブート直後に `.bss` を明示的に 0 クリアしておく必要があります。

### 検証を入れている理由

今回は `is_zeroed()` を使って、実際に `.bss` が 0 になっているかも確認しています。

```c
static bool is_zeroed(const char *buf, size_t len) {
    while (len--) {
        if (*buf++ != 0) {
            return false;
        }
    }
    return true;
}
```

ブートストラップの初期段階では、不正な状態のまま先へ進むより、その場で止めて原因を把握できる方が有益です。そのため、失敗時は `PANIC` へつなげています。

## PANIC の実装

初期化失敗時の停止処理として、`PANIC` を関数とマクロの組み合わせで実装しています。

### マクロ側

```c
__attribute__((noreturn))
void kernel_panic(const char *file, int line, const char *fmt, ...);

#define PANIC(fmt, ...) \
    kernel_panic(__FILE__, __LINE__, fmt, ##__VA_ARGS__)
```

マクロ側では、呼び出し元の `__FILE__` と `__LINE__` を `kernel_panic()` に渡しています。

### 関数側

```c
__attribute__((noreturn))
void kernel_panic(const char *file, int line, const char *fmt, ...) {
    va_list vargs;
    va_start(vargs, fmt);

    printf("KERNEL PANIC: %s:%d: ", file, line);
    vprintf(fmt, vargs);
    printf("\n");

    va_end(vargs);

    for (;;) {
        __asm__ __volatile__("wfi");
    }
}
```

これにより、異常時には

- どのファイルで
- どの行で
- どのような理由で失敗したのか

を出力して、そのまま停止できるようにします。

### `vprintf`

`PANIC` のように可変長引数を受け取る関数では、`printf` だけではなく `vprintf` も必要になります。

```c
void printf(const char *fmt, ...) {
    va_list vargs;
    va_start(vargs, fmt);

    vprintf(fmt, vargs);

    va_end(vargs);
}
```

今回の実装では、フォーマット処理の本体を `vprintf` 側へ寄せ、`printf` は単なるラッパとして扱っています。これにより `kernel_panic()` からも同じフォーマット処理を再利用できます。

## メモリレイアウトの表示

ブートストラップ時には、現在のメモリ配置を確認しやすいように、主要領域の開始・終了・サイズを出力しています。

```c
static void print_memory_layout(void) {
    printf("[boot] memory layout\n");
    printf("[boot]   kernel       : %p - %p (size=%x)\n",
           __kernel_start_addr,
           __kernel_end_addr,
           (unsigned)get_range_size(__kernel_start_addr, __kernel_end_addr));
    printf("[boot]   bss          : %p - %p (size=%x)\n",
           __bss_start_addr,
           __bss_end_addr,
           (unsigned)get_range_size(__bss_start_addr, __bss_end_addr));
    printf("[boot]   kernel stack : %p - %p (size=%x)\n",
           __stack_start_addr,
           __stack_end_addr,
           (unsigned)get_range_size(__stack_start_addr, __stack_end_addr));
    printf("[boot]   free ram     : %p - %p (size=%x)\n",
           __free_ram_start_addr,
           __free_ram_end_addr,
           (unsigned)get_range_size(__free_ram_start_addr, __free_ram_end_addr));
}
```

この出力を入れておくと、リンカスクリプトで定義した各領域が、実際にどのアドレスへ配置されているのかを起動時に確認できます。

特に、次のような確認に役立ちます。

- `.bss` の範囲が想定どおりか
- カーネルスタックの位置とサイズが正しいか
- free ram の開始位置がページ境界に揃っているか
- 領域同士が重なっていないか

## kernel_bootstrap の整理

ここまでの処理は、今後拡張しやすいように、`kernel_bootstrap()` の中で関数分離しています。

```c
static void bootstrap_memory(void) {
    clear_bss();
    print_memory_layout();
}

static void kernel_bootstrap(void) {
    bootstrap_memory();
}
```

現時点では `bootstrap_memory()` だけですが、今後はここに

- `stvec` の設定
- タイマ割り込みの有効化
- `virtio` の初期化

といった処理を段階的に追加していく想定です。

## まとめ

今回は、`memset` の実装から始めて、`.bss` のゼロクリア、`PANIC`、メモリレイアウト表示までを実装しました。

ブート直後の段階で「必要なメモリ状態を作る」「異常時に止まる」「現在の配置を観測できる」という 3 点が揃ったことで、今後のカーネル初期化処理をかなり進めやすくなりました。

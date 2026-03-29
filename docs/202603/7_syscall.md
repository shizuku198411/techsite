---
title: カーネル開発 #7 syscall の実装
date: 2026-03-29 17:00:00
excerpt: U-Mode から ecall で S-Mode へ入り、dispatcher 経由で putchar syscall を処理して printf を使えるようにする
tags: kernel, riscv32, syscall, trap, usermode
---

## はじめに

この記事では、前回実装した U-Mode への移行を土台にして、ユーザ空間からカーネルへ機能を要求するための syscall を実装します。

前回の時点でも、U-Mode から `ecall` を発行して S-Mode の trap handler へ入ること自体はできていました。ただし、その時点では `ecall` を「受けて復帰できる」だけで、syscall 番号や引数を解釈して具体的な処理へ振り分ける仕組みはまだありませんでした。

そこで今回は、`ecall` を syscall の入口として扱い、dispatcher を経由して `putchar` syscall を実行できるようにしました。これにより、最終的にはユーザアプリ側でも `printf()` を利用できるようになります。

今回実装した内容は次の通りです。

- U-Mode の `ecall` を syscall として処理する
- `a6` に syscall 番号、`a0`-`a5` に引数を載せる呼び出し規約を導入する
- S-Mode 側で syscall dispatcher を実装する
- `putchar` syscall を追加する
- user 側 `printf()` が `putchar syscall` を経由して文字出力できるようにする
- syscall の戻り値を `成功: 0以上 / 失敗: -ERR_*` で統一する

## 全体の流れ

今回の syscall 処理の流れを大まかに書くと、次のようになります。

1. ユーザコードが `printf()` を呼ぶ
2. `printf()` の内部で `putchar()` が呼ばれる
3. user 側 `putchar()` が `ecall` を発行する
4. trap で S-Mode の `handle_trap()` へ入る
5. `SCAUSE_ECALL_FROM_U_MODE` として syscall dispatcher を呼ぶ
6. syscall 番号に応じて `putchar` などの個別処理を実行する
7. 戻り値を `a0` に入れて `sret` で U-Mode へ戻る

これにより、U-Mode 側から見れば通常の関数呼び出しのように見えつつ、実際には trap を経由して S-Mode の機能を利用できるようになります。

## user 側 syscall ラッパ

まず、U-Mode 側では `ecall` を直接呼ぶ薄いラッパを用意します。

```c
static int syscall(int sysno, int arg0, int arg1, int arg2, int arg3, int arg4, int arg5) {
    register int a0 __asm__("a0") = arg0;
    register int a1 __asm__("a1") = arg1;
    register int a2 __asm__("a2") = arg2;
    register int a3 __asm__("a3") = arg3;
    register int a4 __asm__("a4") = arg4;
    register int a5 __asm__("a5") = arg5;
    register int a6 __asm__("a6") = sysno;

    __asm__ __volatile__(
        "ecall"
        : "+r" (a0)
        : "r" (a1), "r" (a2), "r" (a3), "r" (a4), "r" (a5), "r" (a6)
        : "memory"
    );

    return a0;
}
```

ここでは、syscall 番号を `a6` に、引数を `a0`-`a5` に入れて `ecall` を発行しています。戻り値は trap 復帰後の `a0` から受け取ります。

今回は最初の syscall として、`putchar()` を次のように実装しました。

```c
int putchar(char ch) {
    return syscall(SYSCALL_PUTCHAR, (int) ch, 0, 0, 0, 0, 0);
}
```

この時点で、user 側からは `putchar()` が普通の関数に見えますが、実際には trap を介してカーネル側の出力処理へつながっています。

## syscall 番号とエラーコード

syscall 番号とエラーコードは共有ヘッダで定義しています。

```c
#define SYSCALL_PUTCHAR     1

#define ERR_INVAL           1
#define ERR_NOSYS           2
```

このヘッダは user / kernel の両方から参照し、番号の不一致を防ぎます。

### 戻り値の規約

今回から、syscall の戻り値規約は次の形に統一しています。

- 成功時: `0` 以上
- 失敗時: `-ERR_*`

現時点の `putchar` は成功時に `0` を返すだけですが、今後

- `read()` のように読み取ったバイト数を返す syscall
- `get_ticks()` のように値自体を返す syscall
- `fork()` のように ID を返す syscall

を追加することを考えると、この形のほうが拡張しやすくなります。

## `SCAUSE_ECALL_FROM_U_MODE` の syscall 化

前回の記事では、`SCAUSE_ECALL_FROM_U_MODE` は「panic せずに受けて、`sepc` を進めて復帰する」という最小処理にしていました。

今回はそこを一段進めて、`ecall` を syscall として解釈し、dispatcher を呼ぶようにしています。

```c
case SCAUSE_ECALL_FROM_U_MODE:
    f->a0 = syscall_handle(f->a6, f->a0, f->a1, f->a2, f->a3, f->a4, f->a5);
    WRITE_CSR(sepc, user_pc + 4);
    return;
```

ここでやっていることは次の 2 つです。

- trap frame 上の `a6`, `a0`-`a5` を syscall 番号と引数として dispatcher に渡す
- 戻り値を `f->a0` に書き戻して、U-Mode 側の戻り値にする

前回と同様に、`sepc` は `ecall` 命令を飛ばすために `4` 進めています。これにより、復帰後は `ecall` の次の命令から再開されます。

## syscall dispatcher の実装

syscall の振り分けは `syscall_handle()` で行います。

```c
int syscall_handle(int sysno, int arg0, int arg1, int arg2, int arg3, int arg4, int arg5) {
    (void) arg1;
    (void) arg2;
    (void) arg3;
    (void) arg4;
    (void) arg5;

    switch (sysno) {
        case SYSCALL_PUTCHAR:
            return syscall_handle_putchar(arg0);

        default:
            return -ERR_NOSYS;
    }
}
```

ここでは、trap frame そのものを個別 syscall へ渡さず、

- syscall 番号を見て振り分ける
- 各 syscall には plain な引数だけを渡す

という構成にしています。

### なぜ trap frame を直接渡さないのか

trap frame は「trap から安全に復帰するための保存構造体」であり、syscall 層の本来の責務ではありません。

そのため、dispatcher が `a0`-`a6` を読み出して syscall 引数へ変換し、その先の個別 syscall 実装は単純な C 関数として扱えるようにしています。

この分離をしておくと、今後 syscall が増えても

- trap まわりのレジスタ退避ロジック
- syscall ABI の解釈
- 各 syscall の業務処理

を別々に整理しやすくなります。

## `putchar` syscall の実装

最初の syscall として、文字を 1 文字出力する `putchar` を実装しました。

```c
int syscall_handle_putchar(int ch) {
    return putchar((char) ch);
}
```

kernel 側の `putchar()` は SBI 経由でコンソールへ文字を出力します。

```c
int putchar(char ch) {
    sbi_call(ch, 0, 0, 0, 0, 0, 0, SBI_PUTCHAR);
    return 0;
}
```

現時点では SBI 側のエラーを細かく見ていないため、成功時は常に `0` を返す単純な実装です。ただし、関数の戻り値型は `int` に揃えてあるため、将来必要になれば `-ERR_*` を返す方向へ拡張できます。

## なぜ direct call ではなく syscall にするのか

ここで疑問になりやすいのは、「文字を出したいだけなら、user 側から直接 kernel の `putchar()` や `sbi_call()` を呼べばよいのではないか」という点です。

しかし、今回 syscall を経由する形にしているのには理由があります。

まず、kernel の `putchar()` や `sbi_call()` は S-Mode 側の機能であり、本来は user 側が直接使うものではありません。U-Mode と S-Mode の境界をきちんと分けるためには、user 側から利用可能な機能は syscall という明示的な入口を通す必要があります。

また、syscall を経由する形にしておくと、

- どの機能を user 側へ公開するか
- どの引数を受け付けるか
- 異常時にどのエラーを返すか

を kernel 側で一元管理できるようになります。

現時点では `putchar` 1 個だけなので遠回りに見えるかもしれませんが、今後 `write`, `read`, `get_ticks` などを追加していくと、この入口を揃えておくことの価値が大きくなります。

つまり、今回 syscall を導入した目的は、単に文字を出すことではなく、user 空間と kernel 空間のあいだに「正規の呼び出し窓口」を作ることにあります。

## user 側 `printf()` との接続

既存の `printf()` 実装は、最終的に `putchar()` を繰り返し呼ぶ構造になっています。

```c
void vprintf(const char *fmt, va_list vargs) {
    while (*fmt) {
        /* ... */
        putchar(*fmt);
        fmt++;
    }
}
```

この `putchar()` が user 側 syscall ラッパへ差し替わったことで、特別な `printf syscall` を用意しなくても、既存のフォーマット処理をそのまま user 空間でも再利用できるようになりました。

この構成の利点は、文字出力の最小単位だけを syscall として実装すれば、上位の `printf()` は user / kernel で共通化しやすいことです。

`printf()` から kernel 側の `putchar` へ到達するまでの流れを、ASCII で書くと次のようになります。

```text
[U-Mode / user app]
printf("ecall occured!\n")
  |
  v
vprintf(...)
  |
  | 1文字ずつ putchar(ch)
  v
putchar(ch)
  |
  | syscall(SYSCALL_PUTCHAR, ch, 0, 0, 0, 0, 0)
  |   - a0 = ch
  |   - a6 = SYSCALL_PUTCHAR
  |   - ecall
  v
================ trap to S-Mode ================
  v
trap_entry
  |
  | レジスタ退避
  v
handle_trap
  |
  | scause == SCAUSE_ECALL_FROM_U_MODE
  v
syscall_handle(sysno, arg0, ...)
  |
  | sysno == SYSCALL_PUTCHAR
  v
syscall_handle_putchar(ch)
  |
  v
kernel putchar(ch)
  |
  | sbi_call(..., SBI_PUTCHAR)
  v
[QEMU / SBI / Console]
  |
  | 文字が表示される
  v
================ return to U-Mode ==============
  v
handle_trap
  |
  | a0 = return value
  | sepc += 4
  | sret
  v
putchar(ch) returns
  |
  v
vprintf(...)
  |
  | 次の文字へ
  v
printf() returns
```

この図からもわかるとおり、`printf()` 自体を直接 syscall にしているわけではなく、最終的な出力単位である `putchar()` を syscall 化することで、user 側のフォーマット処理と kernel 側の実出力処理をきれいに接続しています。

## 責務分離の整理

今回の実装では、責務が次のように分かれています。

- `trap_entry`
  - trap 発生時のレジスタ退避と復帰を担当する
- `handle_trap()`
  - `scause` を見て trap の種類を分岐する
- `syscall_handle()`
  - syscall 番号と引数を解釈して個別 syscall へ振り分ける
- `syscall_handle_putchar()`
  - `putchar` syscall 自体の処理を行う
- user 側 `syscall()`
  - `ecall` を発行する薄いラッパ

このように役割を分けておくことで、今後 syscall を追加する際にも

1. 共有ヘッダへ syscall 番号を追加する
2. user 側ラッパを足す
3. `syscall_handle()` に分岐を追加する
4. 個別処理を新しい `.c` ファイルへ実装する

という流れで見通しよく拡張できるようになります。

## 動作確認

今回の確認ポイントは、user 側で `printf()` を呼んだ結果が、syscall を経由してコンソールへ出力されることです。

現時点の `shell` では、一定間隔ごとに `printf("ecall occured!\\n");` を実行しています。

```c
void main(void) {
    volatile unsigned counter = 0;

    for (;;) {
        counter++;
        if ((counter % 100000000u) == 0) {
            printf("ecall occured!\n");
        }
        __asm__ __volatile__("nop");
    }
}
```

この結果、起動後のコンソールには次のような出力が現れます。

```text
[boot] enter user mode
ecall occured!
ecall occured!
ecall occured!
ecall occured!
```

この出力から、次のことが確認できます。

- U-Mode の user アプリから `printf()` を呼べていること
- `printf()` の内部で `putchar syscall` が繰り返し実行されていること
- S-Mode 側の syscall 処理を経由して、実際にコンソールへ出力できていること

つまり、前回整えた「U-Mode へ入って trap で戻る仕組み」が、今回は実際に user 空間からカーネル機能を呼び出すための syscall 基盤として機能し始めたことになります。

## 現時点の制約

今回の syscall 実装は土台としては十分ですが、まだ簡易的な点もあります。

- syscall は `putchar` 1 個だけで、種類はまだ少ない
- `a0`-`a5` の引数をそのまま整数として扱っている
- ユーザポインタの検証やメモリ保護はまだない
- SBI 呼び出しのエラーを詳細には見ていない
- `printf()` は 1 文字ずつ trap に入るため、出力効率は高くない

つまり、今は「syscall の入り口と戻り値規約を整えた段階」です。本格的な user-kernel 境界の強化や、より高機能な syscall の追加はここから先の課題になります。

## まとめ

今回は、U-Mode から `ecall` を使って S-Mode の機能を呼び出す syscall 基盤を実装し、最初の syscall として `putchar` を追加しました。

これにより、前回までの「U-Mode へ入って trap で戻る」仕組みが、単なる制御移動ではなく、user 空間と kernel 空間をつなぐ実際のインターフェースとして機能し始めました。

今後は、この土台の上に

- 複数の syscall 追加
- 文字列出力や入力系の syscall
- タイマ情報取得
- task / process 管理と連携した syscall

などを段階的に載せていけるようになります。

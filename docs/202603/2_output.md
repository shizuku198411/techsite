---
title: カーネル開発 #2 OpenSBI を利用した文字出力と printf の実装
date: 2026-03-27
excerpt: OpenSBI 経由で文字を出力し、最小限の printf を実装してデバッグ出力の基盤を整備する
tags: kernel, riscv32, output, sbi, printf
---

## はじめに

この記事では、前回実装したブート処理の続きとして、カーネルから文字列を出力する仕組みを実装します。

ブート処理だけが動いていても、画面やシリアルに何も出せない状態では、内部で何が起きているのかを確認しづらくなります。そこで今回は、OpenSBI の機能を利用して 1 文字ずつ出力し、その上に `printf` を重ねるところまで実装します。

今回実装する内容は次の通りです。

- OpenSBI の `ecall` を使って文字を出力する
- `putchar` を用意して 1 文字出力できるようにする
- `%s`, `%d`, `%u`, `%x`, `%X`, `%p`, `%c`, `%%` に対応した `printf` を実装する
- `kernel_main` から実際に各フォーマットを試す

> ソースコードは以下リポジトリで公開しています。
> [GitHub: drizzle](https://github.com/shizuku198411/drizzle)

## 全体の流れ

今回の出力処理の流れを大まかに書くと、次のようになります。

1. `sbi_call` を実装して OpenSBI のサービスを呼び出せるようにする
2. `putchar` を実装して 1 文字出力の最小単位を作る
3. `putchar` を使って `printf` を実装する
4. `kernel_main` から各種フォーマットを出力して動作確認する

この形にしておくと、最初はシンプルに OpenSBI を使ってログを出しつつ、後で UART ドライバへ置き換える場合も、上位の `printf` 側はほとんど変更せずに済みます。

## OpenSBI を利用した文字出力

まずは、S-mode から OpenSBI を呼び出すための `sbi_call` を実装します。

```c
struct sbiret sbi_call(long arg0, long arg1, long arg2, long arg3, long arg4, long arg5, long fid, long eid) {
    register long a0 __asm__("a0") = arg0;
    register long a1 __asm__("a1") = arg1;
    register long a2 __asm__("a2") = arg2;
    register long a3 __asm__("a3") = arg3;
    register long a4 __asm__("a4") = arg4;
    register long a5 __asm__("a5") = arg5;
    register long a6 __asm__("a6") = fid;
    register long a7 __asm__("a7") = eid;

    __asm__ __volatile__(
        "ecall\n"
        : "=r"(a0), "=r"(a1)
        : "r"(a0), "r"(a1), "r"(a2), "r"(a3), "r"(a4), "r"(a5), "r"(a6), "r"(a7)
        : "memory"
    );

    return (struct sbiret){.error = a0, .value = a1};
}
```

RISC-V の SBI 呼び出しでは、引数や拡張 ID を `a0` から `a7` に設定したうえで `ecall` を実行します。

戻り値は `a0` と `a1` に返ってくるため、ここでは `struct sbiret` として受け取れるようにしています。

### `putchar` の実装

1 文字出力は `putchar` として切り出しています。

```c
void putchar(char ch) {
    sbi_call(ch, 0, 0, 0, 0, 0, 0, SBI_PUTCHAR);
}
```

ここでは、OpenSBI の `putchar` 相当のサービスを呼び出して、1 文字ずつシリアル出力しています。

この段階では非常に低機能ですが、文字を 1 つ確実に出せるだけでも、カーネル初期化のデバッグがかなり進めやすくなります。

## printf の実装

次に、`putchar` を使って最小限の `printf` を実装します。

```c
void printf(const char *fmt, ...) {
    va_list vargs;
    va_start(vargs, fmt);

    while (*fmt) {
        if (*fmt == '%') {
            fmt++;
            switch (*fmt) {
                case '\0':
                    putchar('%');
                    goto end;
                case '%':
                    putchar('%');
                    break;
                case 'c': {
                    int value = va_arg(vargs, int);
                    putchar((char)value);
                    break;
                }
                case 's': {
                    const char *s = va_arg(vargs, const char *);
                    if (!s) {
                        s = "(null)";
                    }
                    while (*s) {
                        putchar(*s);
                        s++;
                    }
                    break;
                }
                case 'd': {
                    int value = va_arg(vargs, int);
                    unsigned magnitude = value;
                    if (value < 0) {
                        putchar('-');
                        magnitude = -magnitude;
                    }
                    print_unsigned(magnitude);
                    break;
                }
                case 'u': {
                    unsigned value = va_arg(vargs, unsigned);
                    print_unsigned(value);
                    break;
                }
                case 'x': {
                    unsigned value = va_arg(vargs, unsigned);
                    print_hex(value, 0);
                    break;
                }
                case 'X': {
                    unsigned value = va_arg(vargs, unsigned);
                    print_hex(value, 1);
                    break;
                }
                case 'p': {
                    unsigned value = va_arg(vargs, unsigned);
                    putchar('0');
                    putchar('x');
                    print_hex(value, 0);
                    break;
                }
                default:
                    putchar('%');
                    putchar(*fmt);
                    break;
            }
        } else {
            putchar(*fmt);
        }

        fmt++;
    }

end:
    va_end(vargs);
}
```

本格的な C ライブラリの `printf` に比べるとかなり簡略化していますが、デバッグ用途であればこれだけでも十分役立ちます。

### 今回対応したフォーマット

今回対応したフォーマットは次の通りです。

- `%s`: 文字列
- `%d`: 符号付き 10 進整数
- `%u`: 符号なし 10 進整数
- `%x`: 小文字 16 進数
- `%X`: 大文字 16 進数
- `%p`: ポインタ風の 16 進数表示
- `%c`: 1 文字
- `%%`: `%` 自体の出力

また、`%s` に `NULL` が渡された場合は `(null)` を表示するようにしています。これにより、初期実装の段階でも落ちにくくなります。

### 補助関数

10 進整数や 16 進整数の出力は、補助関数として切り出しています。

```c
static void print_unsigned(unsigned value) {
    unsigned divisor = 1;
    while (value / divisor > 9) {
        divisor *= 10;
    }
    while (divisor > 0) {
        putchar('0' + value / divisor);
        value %= divisor;
        divisor /= 10;
    }
}
```

```c
static void print_hex(unsigned value, int uppercase) {
    const char *digits = uppercase ? "0123456789ABCDEF" : "0123456789abcdef";
    for (int i = 7; i >= 0; i--) {
        unsigned nibble = (value >> (i * 4)) & 0xf;
        putchar(digits[nibble]);
    }
}
```

## kernel_main での動作確認

実際の確認用として、`kernel_main` では各フォーマットをまとめて出力しています。

```c
void kernel_main(void) {
    printf("\nprintf format test start\n");
    printf("string   : %s\n", "Hello World");
    printf("string   : %s\n", (const char *)0);
    printf("char     : %c %c %c\n", 'O', 'S', '!');
    printf("signed   : %d %d %d\n", 0, 42, -42);
    printf("unsigned : %u %u\n", 0u, 1234567890u);
    printf("hex      : %x\n", 0x1234abcd);
    printf("HEX      : %X\n", 0x1234abcd);
    printf("pointer  : %p\n", 0x80200000u);
    printf("percent  : %%\n");
    printf("unknown  : %q\n");
    printf("printf format test end\n");

    __asm__ __volatile__("wfi");
}
```

未対応フォーマットについては `%q` のようにそのまま出すようにしているため、「未対応であること」を出力上で把握しやすくしています。

## 動作確認
実際にカーネルを起動して確認してみます。

```text
printf format test start
string   : Hello World
string   : (null)
char     : O S !
signed   : 0 42 -42
unsigned : 0 1234567890
hex      : 1234abcd
HEX      : 1234ABCD
pointer  : 0x80200000
percent  : %
unknown  : %q
printf format test end
```

正常にコンソールに文字が出力されている、かつ全て意図した通りの出力となっています。

## まとめ

今回は、OpenSBI の `ecall` を利用した文字出力から始めて、その上に最小限の `printf` を実装するところまでを行いました。

これによって、カーネル内部の状態を文字列として確認できるようになり、今後の開発を進めるためのデバッグ基盤が整いました。

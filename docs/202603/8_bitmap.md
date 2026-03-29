---
title: カーネル開発 #8 bitmap によるページ管理の準備
date: 2026-03-29 17:30:00
excerpt: free ram を 4KiB ページ単位に区切り、先頭へ bitmap を配置して管理対象ページ範囲を確定する
tags: kernel, riscv32, memory, bitmap, page
---

## はじめに

この記事では、今後のページアロケータやページテーブル管理の土台として、物理メモリをページ単位で扱うための bitmap 初期化を実装します。

前回までで、ブート処理、trap、syscall の流れまでは整いました。ただし、今後 user メモリやページテーブル、プロセスごとの領域を扱っていくためには、まず「空いている物理ページをどのように管理するか」を決めておく必要があります。

そこで今回は、`__free_ram_start_addr` から `__free_ram_end_addr` までの free ram を対象にして、

- 1ページ = 4KiB
- 1 bit で 1ページを表す bitmap
- bitmap 自身は free ram 先頭に配置

という方針で、ページ管理用の基本情報を初期化するところまで進めました。

今回実装した内容は次の通りです。

- free ram をページ境界へ揃える
- free ram 全体のページ数を計算する
- bitmap が必要とするサイズとページ数を計算する
- bitmap を free ram 先頭に配置する
- bitmap 分を除いた managed range を確定する
- ブート時ログで bitmap 範囲と管理対象範囲を確認できるようにする

## 全体の流れ

今回の bitmap 初期化の流れを大まかに書くと、次のようになります。

1. linker script で用意した free ram 範囲を取得する
2. 開始アドレスをページ境界へ切り上げ、終了アドレスをページ境界へ切り下げる
3. ページ総数を計算する
4. そのページ数を表現するために必要な bitmap サイズを計算する
5. bitmap 自体が占有するページ数を確定する
6. free ram 先頭に bitmap を配置する
7. bitmap の直後を managed range の開始アドレスとする

最終的には、

- bitmap が置かれる範囲
- 実際にページ確保対象となる範囲

を明確に分けた状態を作ります。

## なぜ最初に bitmap だけ用意するのか

ここでまだ `alloc_pages()` や `free_pages()` まで進まず、まずは bitmap の準備だけを実装しています。

これは、メモリ管理では「どこを管理対象にするのか」「管理情報そのものをどこへ置くのか」が曖昧なまま先へ進むと、その後の allocator 実装全体が崩れやすいためです。

特に今回は、bitmap 自体も free ram の一部を消費します。そのため、

- free ram 全体
- bitmap が占有する領域
- 実際にページ確保に使える managed range

をまず正しく切り分けることが重要になります。

## 1ページ = 4KiB の前提

今回のページ管理では、1ページを 4KiB としています。

```c
#define PAGE_SIZE   4096u
```

この単位に揃えておくことで、今後の

- 連続ページ確保
- ページテーブル用メモリ確保
- user stack / kernel stack のページ単位管理

などへ自然につなげやすくなります。

また、ページ境界を揃えるための helper として、次の 2 つを用意しています。

```c
static inline paddr_t align_up_to_page(paddr_t addr) {
    return (addr + PAGE_SIZE - 1) & ~(PAGE_SIZE - 1);
}

static inline paddr_t align_down_to_page(paddr_t addr) {
    return addr & ~(PAGE_SIZE - 1);
}
```

ここで

- 開始アドレスは切り上げ
- 終了アドレスは切り下げ

にしているのは、管理対象範囲を常に「ページ単位できれいに割り切れる区間」にしたいためです。

## 管理対象メモリ範囲

管理対象にするのは、linker script で定義した free ram 範囲です。

```ld
. = ALIGN(4096);
.fram (NOLOAD) : ALIGN(4096) {
    __free_ram_start_addr = .;
    . += 64 * 1024 * 1024;
    __free_ram_end_addr = .;
}
```

ブートストラップ時には、この範囲を allocator 初期化へ渡します。

```c
static void init_page_allocator(void) {
    paddr_t free_start = (paddr_t) __free_ram_start_addr;
    paddr_t free_end   = (paddr_t) __free_ram_end_addr;

    memory_init(free_start, free_end);
}
```

linker script 側でも 4KiB 境界へ揃えていますが、allocator 側でも再度ページ境界へ丸めるようにしています。これにより、今後 free ram の決め方が変わっても allocator 自身の前提が崩れにくくなります。

## bitmap のサイズ計算

bitmap では、1 bit で 1ページを表します。そのため、まずページ総数を求めます。

```c
static uint32_t calc_total_pages(paddr_t start, paddr_t end) {
    return (end - start) / PAGE_SIZE;
}
```

次に、そのページ数を表すのに必要な byte 数を求めます。

```c
static uint32_t calc_bitmap_bytes(uint32_t page_count) {
    return (page_count + 7) / 8;
}
```

さらに、bitmap 自体もページ単位で配置したいため、必要 byte 数をページ境界へ切り上げます。

```c
static uint32_t calc_bitmap_page_count(uint32_t page_count) {
    return align_up_to_page(calc_bitmap_bytes(page_count)) / PAGE_SIZE;
}
```

### なぜ 1 回ではなく整合するまで計算するのか

ここで少し注意が必要なのは、bitmap 自体が free ram の一部を消費することです。

つまり、

- 管理したいページ数が多いほど bitmap は大きくなる
- bitmap が大きいほど、実際に管理できるページ数は減る

という関係があります。

そのため今回は、次のように「bitmap ページ数」と「managed page 数」が整合するまで再計算しています。

```c
uint32_t new_managed_pages = total_pages;
do {
    managed_page_count = new_managed_pages;
    bitmap_page_count = calc_bitmap_page_count(managed_page_count);
    if (bitmap_page_count >= total_pages) {
        PANIC("bitmap too large for free ram");
    }
    new_managed_pages = total_pages - bitmap_page_count;
} while (new_managed_pages != managed_page_count);
```

これにより、「bitmap を置いた結果として実際に管理可能なページ数」と、bitmap の表現能力が一致した状態を作れます。

## bitmap の配置

bitmap は free ram の先頭へ配置しています。

```c
bitmap = (uint8_t *) free_start;
memset(bitmap, 0, bitmap_page_count * PAGE_SIZE);

managed_region_start = free_start + bitmap_page_count * PAGE_SIZE;
managed_page_count = total_pages - bitmap_page_count;
```

ここで、

- `bitmap`
  - free ram の先頭アドレス
- `managed_region_start`
  - bitmap の直後

となります。

つまり、メモリの見え方は次のようになります。

```text
free ram start
  |
  v
+----------------------+  <- bitmap
| bitmap pages         |
+----------------------+  <- managed_region_start
| managed pages        |
| managed pages        |
| managed pages        |
+----------------------+  <- free ram end
```

この時点で、bitmap が置かれた領域と、今後 `alloc_pages()` の対象にする領域は明確に分離されています。

## 動作確認

起動時には、bitmap 範囲と managed range をそのままログへ出力するようにしました。

```text
[boot]   memory information
[boot]     memory layout
[boot]       kernel       : 0x80200000 - 0x80201650 (size=00001650)
[boot]       bss          : 0x80201620 - 0x80201648 (size=00000028)
[boot]       kernel stack : 0x80201650 - 0x80211650 (size=00010000)
[boot]       free ram     : 0x80212000 - 0x84212000 (size=04000000)
[boot]     pages
[boot]       bitmap range  : 0x80212000 - 0x80213000 (pages=1)
[boot]       managed range : 0x80213000 - 0x84212000 (pages=16383)
```

このログから、次のことが確認できます。

- free ram 全体は `0x80212000 - 0x84212000`
- bitmap は先頭 1 ページ分に配置されている
- managed range は bitmap の直後から始まっている
- `bitmap end == managed start` となっており、重複も隙間もない

また、64MiB の free ram は 4KiB ページで 16384 ページになります。そのうち 1 ページを bitmap 用に使っているため、管理対象は 16383 ページとなり、ログとも一致しています。

## 現時点の制約

今回の実装は「bitmap を置いて管理対象範囲を確定する」段階であり、まだ allocator 本体は入っていません。

- `alloc_pages()` / `free_pages()` は未実装
- bitmap の各 bit をどう解釈して更新するかは次段階
- ページの確保状態はまだ固定で、走査や解放のロジックはない
- user メモリやページテーブル管理にはまだ接続していない

つまり、いまは「どこを管理するのか」「管理情報をどこへ置くのか」を固めた段階です。ここが正しくできていることで、この先のページアロケータ実装を安心して進められるようになります。

## まとめ

今回は、free ram を 4KiB ページ単位で扱うための準備として、bitmap の配置と managed range の確定までを実装しました。

これにより、メモリ管理の入り口として

- 管理対象の物理メモリ範囲
- bitmap が占有する範囲
- 実際に配布可能なページ範囲

が明確に分かれました。

次の段階では、この bitmap を使って実際に空きページを探索し、連続ページを確保・解放できるページアロケータ本体へ進めるようになります。

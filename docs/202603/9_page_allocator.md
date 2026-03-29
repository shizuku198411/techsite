---
title: カーネル開発 #9 ページアロケータの実装
date: 2026-03-29 18:30:00
excerpt: bitmap を使った palloc() / pfree() を実装し、連続ページ確保と解放をできるようにする
tags: kernel, riscv32, memory, bitmap, page, allocator
---

## はじめに

この記事では、前回準備した bitmap を使って、実際に物理ページを確保・解放するページアロケータを実装します。

前回の時点では、

- free ram を 4KiB ページ単位で扱う
- free ram 先頭に bitmap を置く
- bitmap 領域を除いた managed range を確定する

ところまでができていました。ただし、その時点ではまだ「空いているページを探して返す」「使い終わったページを解放する」という allocator 本体はありませんでした。

そこで今回は、

- `palloc(n)` による連続ページ確保
- `pfree(paddr, n)` による連続ページ解放
- `1 = 使用中 / 0 = 空き` の bitmap 更新
- 解放済みページの再利用確認
- self-test による基本動作確認

までを実装しました。

## 全体の流れ

今回のページアロケータの流れを大まかに書くと、次のようになります。

1. bootstrap 時に `memory_init()` で bitmap と managed range を初期化する
2. `palloc(n)` が bitmap を先頭から走査し、`n` ページ連続の空き領域を探す
3. 見つかった範囲の bit を `1` にして使用中へ更新する
4. managed range 内の対応する物理アドレスを返す
5. `pfree(paddr, n)` が対象範囲の妥当性を確認する
6. 対象ページを 0 クリアしてから bitmap の bit を `0` に戻す

これにより、今後ページテーブルやプロセス用メモリを確保するための最小限の物理ページ allocator が使えるようになります。

## bitmap の意味

今回の bitmap は、managed range に含まれるページを 1 bit ずつ管理しています。

- `1`
  使用中
- `0`
  空き

bitmap 自体は free ram の先頭に置かれており、`palloc()` が返す managed range には含めません。

```c
static uint8_t *bitmap;
static paddr_t managed_region_start;
static uint32_t managed_page_count;
```

ここで、

- `bitmap`
  free ram 先頭に置かれた管理領域
- `managed_region_start`
  実際に配布可能な最初の物理ページ
- `managed_page_count`
  配布対象となるページ数

を表しています。

メモリの見え方は次のようになります。

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

## bitmap の基本操作

ページの使用状態を見る・立てる・落とすために、bitmap 操作用の helper を用意しています。

```c
static bool bitmap_test(uint32_t idx) {
    return (bitmap[idx / 8] >> (idx % 8)) & 1;
}

static void bitmap_set(uint32_t idx) {
    bitmap[idx / 8] |= (uint8_t) (1u << (idx % 8));
}

static void bitmap_clear(uint32_t idx) {
    bitmap[idx / 8] &= (uint8_t) ~(1u << (idx % 8));
}
```

ここで `idx` は、「managed range の先頭から何ページ目か」を表しています。つまり、bitmap の index 0 は `managed_region_start` に対応し、index 1 はその次の 4KiB ページに対応します。

## `palloc()` の実装

`palloc(n)` は、`n` ページぶんの連続空き領域を探して返します。

```c
paddr_t palloc(uint32_t n) {
    uint32_t run = 0;
    for (uint32_t i = 0; i < managed_page_count; i++) {
        if (bitmap_test(i)) {
            run = 0;
            continue;
        }

        run++;
        if (run == n) {
            uint32_t start = i + 1 - n;
            for (uint32_t j = start; j <= i; j++) {
                bitmap_set(j);
            }

            paddr_t paddr = managed_region_start + start * PAGE_SIZE;
            memset((void *) paddr, 0, n * PAGE_SIZE);
            return paddr;
        }
    }

    return (paddr_t) 0;
}
```

この実装では、bitmap を先頭から線形走査し、連続して空いているページ数を `run` で数えています。

- 使用中ページに当たったら `run = 0`
- 空きページなら `run++`
- `run == n` になった時点で、その区間を確保成功とみなす

という流れです。

### なぜ線形走査でよいのか

現時点では allocator の最初の実装段階であり、まずは

- 実装が単純であること
- 挙動が読みやすいこと
- デバッグしやすいこと

を優先しています。

bitmap + 線形走査は高速とは言えませんが、4KiB ページ単位の最小 allocator としては十分に扱いやすく、今後の改善もしやすい構成です。

### 失敗時は `NULL` 相当を返す

空き領域が見つからなかった場合、`palloc()` は `0` を返します。

```c
return (paddr_t) 0;
```

これにより呼び出し側では、

```c
paddr_t p = palloc(2);
if (p == 0) {
    /* out of memory */
}
```

のように、通常のメモリ確保失敗として扱えるようにしています。

## `pfree()` の実装

`pfree(paddr, n)` は、指定された連続ページを解放します。

```c
void pfree(paddr_t paddr, uint32_t n) {
    uint32_t start = (paddr - managed_region_start) / PAGE_SIZE;

    for (uint32_t i = 0; i < n; i++) {
        uint32_t idx = start + i;
        if (!bitmap_test(idx)) {
            PANIC("double free detected addr: %p", paddr + i * PAGE_SIZE);
        }
    }

    memset((void *) paddr, 0, n * PAGE_SIZE);

    for (uint32_t i = 0; i < n; i++) {
        uint32_t idx = start + i;
        bitmap_clear(idx);
    }
}
```

`pfree()` では、単に bit を落とすだけではなく、先に対象範囲の妥当性を確認しています。

具体的には、

- allocator が初期化済みか
- `n` が 0 ではないか
- アドレスがページ境界に揃っているか
- managed range の外を指していないか
- 対象範囲が本当に使用中か

を確認しています。

### なぜ全ページ確認してから解放するのか

もし途中まで bit を落としてからエラーにすると、bitmap の状態が半端に更新されて allocator 全体が壊れる可能性があります。

そのため今回は、

1. 対象範囲をすべて検証する
2. ページ内容を 0 クリアする
3. bitmap を解放状態へ更新する

という順番にしています。

これにより、異常系でも「途中までだけ解放された状態」を作りにくくなります。

### 解放時に 0 クリアする理由

今回の `pfree()` では、解放と同時にページ内容を `memset(..., 0, ...)` でクリアしています。

これは、

- 前回使われていた内容を次回利用者へ見せない
- 再利用時のデバッグをしやすくする
- 初期値が 0 であることを前提にしたコードを書きやすくする

ためです。

また `palloc()` 側でも返却前に 0 クリアしているため、解放直後・再利用直前のどちらでも内容が残りにくい形になっています。

## 断片化した場合の挙動

今回の allocator では「連続ページ確保」を行うため、単に空きページ数が足りているだけでは確保できない場合があります。

たとえば次のような状態を考えます。

1. `palloc(2)` で先頭 2 ページを確保する
2. `palloc(1)` でその直後の 1 ページを確保する
3. 最初の 2 ページだけ `pfree()` する

この時点では、空きページは 2 ページありますが、その直後の 1 ページはまだ使用中です。したがって `palloc(3)` は先頭へは入れず、その次に見つかる 3 連続空き領域を返すことになります。

これは不具合ではなく、「連続ページが必要」という allocator の仕様どおりの動きです。

## self-test による確認

今回は `kernel.c` に直接確認コードを書くのではなく、self-test 基盤へ切り出して動作確認しています。

テストでは主に次の 3 パターンを見ています。

- 最初の連続確保が managed range 先頭から始まること
- 一部だけ解放した状態では、大きい連続確保が先頭へ戻らないこと
- 隣接する領域をすべて解放したあとには、再び先頭から確保できること

テストコードの流れは次のようになります。

```c
paddr_t first_alloc = palloc(2);
paddr_t second_alloc = palloc(1);

pfree(first_alloc, 2);

paddr_t third_alloc = palloc(3);

pfree(second_alloc, 1);
pfree(third_alloc, 3);

paddr_t merged_alloc = palloc(3);
```

## 動作確認

`RUN_TESTS=1` で起動すると、self-test から allocator の基本動作を確認できます。

```text
[test] run kernel tests
[test] memory allocator: OK
[test] all kernel tests passed
```

また、allocator 単体の確認としては、次のようなログを得ています。

```text
page alloc 1 (2 page): 0x80213000
page alloc 2 (1 page): 0x80215000
page re-alloc 1 (3 page): 0x80216000
page alloc 2 (1 page): 0x80215000
```

この結果から、次のことが確認できます。

- 最初の 2 ページ確保は managed range 先頭から始まる
- その次の 1 ページ確保は直後のページを返す
- 最初の 2 ページだけ解放しても、3 ページ確保は先頭へ戻らない
- 中間にまだ使用中ページがあるため、次の 3 連続空き領域から確保される

さらに、すべて解放したあとには self-test により再び先頭から 3 ページ確保できることも確認しています。

## 現時点の制約

今回のページアロケータは、今後のページテーブル管理やプロセス管理の土台としては十分ですが、まだ最小構成です。

- 走査は線形であり、高速化はしていない
- 異常系では `PANIC` する箇所が多い
- `palloc()` は最初に見つかった連続空き領域を返す単純な first-fit
- 解放済みページの詳細なデバッグ情報まではまだ持っていない
- user 空間や仮想メモリ管理にはまだ接続していない

ただし、bitmap の配置、連続ページ探索、解放時検証、self-test による確認までが揃ったことで、今後のメモリ管理機能を載せる土台としてはかなり安定した状態になりました。

## まとめ

今回は、前回準備した bitmap を使って、物理ページの確保・解放を行う `palloc()` / `pfree()` を実装しました。

これにより、

- 4KiB 単位で物理ページを管理できる
- 連続ページを確保できる
- 解放と再利用ができる
- 断片化時の挙動を確認できる
- self-test により基本動作を継続的に確認できる

状態になりました。

次の段階では、このページアロケータをページテーブルや user メモリ領域の管理へ接続していくことで、より本格的なメモリ管理へ進められそうです。

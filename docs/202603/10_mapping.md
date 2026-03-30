---
title: カーネル開発 #10 カーネル / ユーザ空間のマッピング
date: 2026-03-30 10:30:00
excerpt: SV32 のページテーブルを導入し、kernel の identity mapping と user の仮想アドレスマッピングを実装する
series: riscv-kernel
seriesOrder: 10
tags: kernel, riscv32, memory, paging, sv32, usermode
---

## はじめに

この記事では、前回までに実装した bitmap とページアロケータを土台にして、SV32 のページテーブルによるアドレスマッピングを実装します。

前回の時点では、物理ページを `palloc()` / `pfree()` で管理できるようになっていました。ただし、まだ仮想アドレスから物理アドレスへの変換は行っておらず、kernel も user も物理アドレスをそのまま使う状態でした。

そこで今回は、

- SV32 のページテーブルを用意する
- kernel 用 root page table を作成する
- kernel 空間を identity mapping する
- user 空間を `USER_BASE` へマッピングする
- user stack 範囲を `user.ld` で定義し、その情報を kernel 側へ取り込む
- `satp` を切り替えて、ページング有効化後に U-Mode へ入る

ところまで進めました。

今回実装した内容は、今後 process や scheduler を入れていくときの「アドレス空間管理の最初の形」になります。

## 全体の流れ

今回の処理全体を大まかに書くと、次のようになります。

1. bootstrap で bitmap allocator を初期化する
2. kernel 用 root page table を 1 ページ確保する
3. kernel 領域を identity mapping する
4. `satp` を kernel page table へ切り替えてページングを有効化する
5. user バイナリを物理メモリ上へ展開する
6. kernel page table を土台にした user page table を新規に作る
7. user code と user stack を user 仮想アドレスへ map する
8. `satp` を user page table に切り替えて U-Mode へ入る

これにより、

- kernel はそのまま identity mapping で動く
- user は `USER_BASE` から始まる仮想アドレス空間で動く

という分離ができるようになります。

## SV32 のフラグ定義

ページテーブルで使う最低限のフラグは次のように定義しています。

```c
#define SATP_SV32   (1u << 31)
#define PAGE_V      (1 << 0)
#define PAGE_R      (1 << 1)
#define PAGE_W      (1 << 2)
#define PAGE_X      (1 << 3)
#define PAGE_U      (1 << 4)
```

ここで大事なのは `PAGE_U` です。これが立っていないページは U-Mode から参照できません。

今回の実装では、

- kernel 領域
  - `PAGE_U` なし
- user code
  - `PAGE_R | PAGE_X | PAGE_U`
- user stack
  - `PAGE_R | PAGE_W | PAGE_U`

という形でマッピングしています。

## `map_page()` の実装

単一ページの map は `map_page()` で行います。

```c
void map_page(uint32_t *table1, vaddr_t vaddr, paddr_t paddr, uint32_t flags) {
    uint32_t vpn1 = (vaddr >> 22) & 0x3ff;
    if ((table1[vpn1] & PAGE_V) == 0) {
        paddr_t pt_paddr = palloc(1);
        table1[vpn1] = ((pt_paddr / PAGE_SIZE) << 10) | PAGE_V;
    }

    uint32_t vpn0 = (vaddr >> 12) & 0x3ff;
    uint32_t *table0 = (uint32_t *) ((table1[vpn1] >> 10) * PAGE_SIZE);
    table0[vpn0] = ((paddr / PAGE_SIZE) << 10) | flags | PAGE_V;
}
```

ここでは、

- `vpn1` で第 1 段ページテーブルを引く
- 必要なら第 2 段ページテーブルを `palloc(1)` で作る
- `vpn0` に leaf PTE を書く

という流れで SV32 の 2 段ページテーブルを構築しています。

### `double map` を panic にしている理由

同じ仮想ページに対して 2 回 map すると、既存 mapping を意図せず上書きしてしまう可能性があります。

そのため今回は、

```c
if ((table0[vpn0] & PAGE_V) != 0) {
    PANIC("double map occured");
}
```

として、すでに有効な PTE が入っている場合は panic にしています。

現時点では上書き更新よりも「想定外の重複を早く検知する」ことを優先しています。

## `map_kernel_region()` による範囲 map

複数ページにまたがる領域を張るために、`map_kernel_region()` を用意しました。

```c
void map_kernel_region(uint32_t *table1, vaddr_t vaddr, paddr_t paddr, size_t size, uint32_t flags) {
    size_t mapped_size = align_up_to_page(size);
    for (size_t offset = 0; offset < mapped_size; offset += PAGE_SIZE) {
        map_page(table1, vaddr + offset, paddr + offset, flags);
    }
}
```

この helper により、

- kernel image
- free ram
- user code
- user stack

のような「ページ単位の連続領域」を単純なループで map できるようになりました。

## kernel page table の作成

まずは boot 時に kernel 用の root page table を作成します。

```c
paddr_t create_kernel_page_table(void) {
    paddr_t root_paddr = palloc(1);
    uint32_t *root_table = (uint32_t *) root_paddr;

    map_kernel_region(root_table,
                      align_down_to_page((vaddr_t) __kernel_start_addr),
                      align_down_to_page((paddr_t) __kernel_start_addr),
                      (size_t) (__stack_end_addr - __kernel_start_addr),
                      PAGE_R | PAGE_W | PAGE_X);
    map_kernel_region(root_table,
                      align_down_to_page((vaddr_t) __free_ram_start_addr),
                      align_down_to_page((paddr_t) __free_ram_start_addr),
                      (size_t) (__free_ram_end_addr - __free_ram_start_addr),
                      PAGE_R | PAGE_W);

    return root_paddr;
}
```

ここでは最初の実装として、

- kernel image から kernel stack までをまとめて identity mapping
- free ram 全体を `R | W` で identity mapping

しています。

### なぜまずは identity mapping なのか

ページングを有効化した直後でも、現在実行中の kernel code や stack に継続してアクセスできる必要があります。

そのため、最初の bring-up 段階では

- 仮想アドレス = 物理アドレス

となる identity mapping が最も扱いやすく、安全です。

## kernel page table の有効化

bootstrap では、kernel page table を作成したあと `satp` を切り替えます。

```c
static void enable_paging(paddr_t root_pt) {
    uint32_t satp = SATP_SV32 | (root_pt / PAGE_SIZE);
    WRITE_CSR(satp, satp);
    __asm__ __volatile__("sfence.vma");
}
```

この処理により、以後の S-Mode 実行は SV32 のページ変換を経由するようになります。

## user 仮想アドレスと物理配置の分離

今回の大きな変更点の 1 つが、user の仮想実行アドレスと、実際の物理ロード先を分離したことです。

現在は次のようにしています。

- user 仮想アドレス
  - `USER_BASE = 0x01000000`
- user バイナリの物理ロード先
  - `USER_LOAD_PADDR = 0x80300000`

つまり、user code は

```text
virtual  0x01000000 -> physical 0x80300000
```

という対応で実行されます。

これにより、今後 process ごとに

- 同じ user 仮想アドレス
- 異なる物理配置先

を持たせる形へ自然につなげられるようになります。

## user stack 範囲を `user.ld` で定義する

user stack 範囲は kernel 側の固定値ではなく、`user.ld` で定義するようにしました。

```ld
.ustack (NOLOAD) : ALIGN(4096) {
    __user_stack_start_addr = .;
    . += 64 * 1024;
    __user_stack_end_addr = .;
}
```

ここで `NOLOAD` にしているのは、stack は初期化済みデータとして user image に含めたいわけではなく、「仮想アドレス空間上に予約したい領域」だからです。

また、image 本体の終端も同時に定義しています。

```ld
__user_start_addr = .;
/* text / rodata / data / bss */
__user_image_end_addr = .;
```

これにより、

- user image の開始位置
- user image の終端
- user stack の開始位置
- user stack の終端

を linker script だけで管理できるようになりました。

## user layout を kernel 側へ共有する

kernel は `user.ld` を直接読むことができないため、`Makefile` で `bin/user.elf` から symbol を抜き出し、`obj/user_layout.h` を自動生成しています。

生成される内容は次のようになります。

```c
#define USER_IMAGE_END 0x010003b0u
#define USER_STACK_TOP 0x01011000u
#define USER_STACK_BASE 0x01001000u
#define USER_BASE 0x01000000u
#define USER_STACK_SIZE  (USER_STACK_TOP - USER_STACK_BASE)
#define USER_STACK_PAGES (USER_STACK_SIZE / 4096u)
```

この header を kernel 側から include することで、user 側レイアウト変更が kernel 側へ自動的に反映されるようになりました。

## user page table の作成

user 実行時には、kernel page table を土台にした user page table を新しく作ります。

```c
paddr_t create_user_page_table(vaddr_t user_vaddr,
                               paddr_t user_paddr,
                               size_t user_size,
                               vaddr_t user_stack_top,
                               uint32_t user_stack_pages) {
    paddr_t root_paddr = palloc(1);
    uint32_t *root_table = (uint32_t *) root_paddr;
    memcpy(root_table, (void *) kernel_root_page_table, PAGE_SIZE);

    map_kernel_region(root_table, user_vaddr, user_paddr, user_size, PAGE_R | PAGE_X | PAGE_U);

    paddr_t user_stack_paddr = palloc(user_stack_pages);
    vaddr_t user_stack_base = user_stack_top - user_stack_pages * PAGE_SIZE;
    map_kernel_region(root_table, user_stack_base, user_stack_paddr,
                      user_stack_pages * PAGE_SIZE, PAGE_R | PAGE_W | PAGE_U);

    return root_paddr;
}
```

ここでやっていることは次の通りです。

1. root page table 1 ページを確保する
2. kernel 用 root page table を丸ごとコピーする
3. user code を `PAGE_U | PAGE_R | PAGE_X` で map する
4. user stack を新しく物理ページ確保し、`PAGE_U | PAGE_R | PAGE_W` で map する

この構成にしておくと、将来 process を作るときにも

- kernel mapping は共通
- user mapping だけ process ごとに差し替える

という形で再利用しやすくなります。

## U-Mode へ入るときの `satp` 切り替え

`enter_user_mode()` では、U-Mode に入る直前に user page table へ `satp` を切り替えます。

```c
void enter_user_mode(unsigned int entry, unsigned int user_sp, paddr_t page_table) {
    __asm__ __volatile__(
        "srli a2, a2, 12\n"
        "li t0, %[satp_sv32]\n"
        "or a2, a2, t0\n"
        "csrw satp, a2\n"
        "sfence.vma\n"
        "csrw sepc, a0\n"
        "mv sp, a1\n"
        "li t0, %[sstatus_spie]\n"
        "csrw sstatus, t0\n"
        "sret\n"
    );
}
```

これにより、

- `sepc = USER_BASE`
- `sp = USER_STACK_TOP`
- `satp = user page table`

の状態で `sret` できるようになりました。

## 動作確認

起動時ログでは、user の仮想アドレスと物理ロード先、stack 範囲を確認できます。

```text
[boot] load user binary
[boot]   user base      : 0x01000000
[boot]   user load addr : 0x80300000
[boot]   user size      : 000003b0
[boot]   user stack     : 0x01001000 - 0x01011000 (size=00010000)
[boot]   user stack top : 0x01011000
```

また、QEMU monitor の `info mem` では次のように表示されました。

```text
vaddr    paddr            size     attr
-------- ---------------- -------- -------
01000000 0000000080300000 00001000 r-xu-a-
0100f000 0000000080228000 00001000 rw-u-ad
80200000 0000000080200000 00002000 rwx--a-
80202000 0000000080202000 00001000 rwx--ad
```

この結果から、次のことが確認できます。

- user code は `0x01000000` から実行されている
- user code は物理 `0x80300000` に対応している
- user stack は `PAGE_U | PAGE_R | PAGE_W` で別物理ページへ map されている
- kernel は引き続き identity mapping で見えている

## 現時点の整理

今回の時点では、まだ process や scheduler は実装していません。

そのため今の構成は、

- kernel page table を 1 つ持つ
- 単一の user page table を作る
- その 1 つの user 実行環境へ入る

という段階です。

ただし、今回 `create_user_page_table()` を切り出しておいたことで、将来 process 作成時に

- user image の物理ロード
- user stack 確保
- process ごとの page table 作成

をまとめて扱う土台ができました。

## まとめ

今回は、SV32 のページテーブルを導入し、

- kernel の identity mapping
- user 仮想アドレスと物理配置の分離
- user stack の専用マッピング
- `satp` 切り替えによる U-Mode 実行

までを実装しました。

これにより、今後の process 管理や scheduler 実装へ向けて、「アドレス空間を切り替えて user を走らせる」という重要な基盤が整いました。

次の段階では、この user page table を process 単位で持たせることで、複数実行主体を管理する方向へ進められそうです。

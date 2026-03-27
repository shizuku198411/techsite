<script setup>
import hljs from "highlight.js/lib/core";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import plaintext from "highlight.js/lib/languages/plaintext";
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { getDocByParams } from "../lib/docs";

hljs.registerLanguage("c", c);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("plaintext", plaintext);
hljs.registerLanguage("text", plaintext);

const route = useRoute();
const articleBodyRef = ref(null);

const article = computed(() =>
  getDocByParams(String(route.params.yearMonth), String(route.params.slug)),
);

async function highlightCodeBlocks() {
  await nextTick();
  if (!articleBodyRef.value) {
    return;
  }

  const blocks = articleBodyRef.value.querySelectorAll("pre code");
  for (const block of blocks) {
    hljs.highlightElement(block);
    const normalizedHtml = block.innerHTML.replace(/\n$/, "");
    const lines = normalizedHtml.split("\n");
    block.innerHTML = lines
      .map((line) => `<span class="code-line">${line || " "}</span>`)
      .join("");
  }
}

watch(article, () => {
  highlightCodeBlocks();
});

onMounted(() => {
  highlightCodeBlocks();
});
</script>

<template>
  <section v-if="article" class="page-card article-page">
    <p class="page-label">Docs / {{ article.yearMonth }}</p>
    <h1 class="page-title">{{ article.title }}</h1>
    <p class="article-meta">{{ article.date }}</p>
    <div class="tag-row">
      <span v-for="tag in article.tags" :key="tag" class="tag-chip">{{ tag }}</span>
    </div>
    <div class="article-layout">
      <aside v-if="article.headings.length > 0" class="article-toc">
        <p class="article-toc-label">Contents</p>
        <nav aria-label="Table of contents">
          <a
            v-for="heading in article.headings"
            :key="heading.id"
            :href="`#${heading.id}`"
            class="article-toc-link"
            :class="{
              'is-sub': heading.level === 3,
            }"
          >
            {{ heading.level === 2 ? `${heading.numbering}. ${heading.title}` : `${heading.numbering} ${heading.title}` }}
          </a>
        </nav>
      </aside>

      <div ref="articleBodyRef" class="article-body" v-html="article.html"></div>
    </div>
    <RouterLink class="inline-back-link" to="/docs">Docs 一覧へ戻る</RouterLink>
  </section>

  <section v-else class="page-card">
    <p class="page-label">Docs</p>
    <h1 class="page-title">Post Not Found</h1>
    <p class="page-description">
      指定された記事は存在しないか、まだ公開されていません。
    </p>
    <RouterLink class="inline-back-link" to="/docs">Back to Docs</RouterLink>
  </section>
</template>

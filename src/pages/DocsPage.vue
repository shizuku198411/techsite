<script setup>
import { computed } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { filterDocs, getTotalPages } from "../lib/docs";

const PAGE_SIZE = 10;
const route = useRoute();
const router = useRouter();
const searchQuery = computed(() =>
  typeof route.query.q === "string" ? route.query.q.trim() : "",
);
const searchMode = computed(() => (route.query.mode === "tag" ? "tag" : "text"));

const currentPage = computed(() => {
  const rawValue = Number.parseInt(route.query.page ?? "1", 10);
  return Number.isNaN(rawValue) || rawValue < 1 ? 1 : rawValue;
});

const filteredDocs = computed(() => filterDocs(searchMode.value, searchQuery.value));

const totalPages = computed(() => getTotalPages(PAGE_SIZE, filteredDocs.value));

const pagedDocs = computed(() => {
  const safePage = Math.min(currentPage.value, totalPages.value);
  const startIndex = (safePage - 1) * PAGE_SIZE;
  return filteredDocs.value.slice(startIndex, startIndex + PAGE_SIZE);
});

function changePage(page) {
  const safePage = Math.min(Math.max(page, 1), totalPages.value);
  const query = {};

  if (searchQuery.value) {
    query.q = searchQuery.value;
    query.mode = searchMode.value;
  }

  if (safePage !== 1) {
    query.page = String(safePage);
  }

  router.push({
    path: "/docs",
    query,
  });
}
</script>

<template>
  <section class="page-card">
    <p class="page-label">Docs</p>
    <h2 class="page-title">All Docs</h2>
    <p v-if="searchQuery" class="search-summary">
      {{ searchMode === "tag" ? "Tag" : "Title / Page" }} search:
      <span class="search-summary-value">{{ searchQuery }}</span>
      <span class="search-summary-count">{{ filteredDocs.length }} hits</span>
    </p>

    <div class="article-stack">
      <article v-for="doc in pagedDocs" :key="doc.id" class="article-card">
        <p class="article-meta">{{ doc.displayDate }} / {{ doc.yearMonth }}</p>
        <h2 class="article-title">
          <RouterLink :to="doc.path">{{ doc.title }}</RouterLink>
        </h2>
        <p class="article-excerpt">{{ doc.excerpt }}</p>
        <div class="tag-row">
          <span v-for="tag in doc.tags" :key="tag" class="tag-chip">{{ tag }}</span>
        </div>
      </article>
    </div>

    <p v-if="filteredDocs.length === 0" class="empty-state">
      No posts matched your search.
    </p>

    <nav class="pagination" aria-label="Docs pagination">
      <button
        class="pagination-button"
        :disabled="currentPage <= 1"
        @click="changePage(currentPage - 1)"
      >
        Previous
      </button>
      <span class="pagination-status">{{ currentPage }} / {{ totalPages }}</span>
      <button
        class="pagination-button"
        :disabled="currentPage >= totalPages"
        @click="changePage(currentPage + 1)"
      >
        Next
      </button>
    </nav>
  </section>
</template>

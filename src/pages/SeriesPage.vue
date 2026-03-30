<script setup>
import { ref } from "vue";
import { RouterLink } from "vue-router";
import { getSeriesCollections } from "../lib/docs";

const PAGE_SIZE = 5;
const seriesGroups = getSeriesCollections();
const expandedSeriesId = ref("");
const currentPages = ref(
  Object.fromEntries(seriesGroups.map((series) => [series.id, 1])),
);

function toggleSeries(seriesId) {
  expandedSeriesId.value = expandedSeriesId.value === seriesId ? "" : seriesId;
}

function getSeriesPageCount(series) {
  return Math.max(1, Math.ceil(series.docs.length / PAGE_SIZE));
}

function getPagedDocs(series) {
  const currentPage = currentPages.value[series.id] ?? 1;
  const startIndex = (currentPage - 1) * PAGE_SIZE;
  return series.docs.slice(startIndex, startIndex + PAGE_SIZE);
}

function changeSeriesPage(seriesId, nextPage, pageCount) {
  const safePage = Math.min(Math.max(nextPage, 1), pageCount);
  currentPages.value = {
    ...currentPages.value,
    [seriesId]: safePage,
  };
}
</script>

<template>
  <section class="page-card">
    <p class="page-label">Series</p>
    <h1 class="page-title">Series Index</h1>
    <p class="page-description">
    </p>

    <div class="series-grid">
      <article
        v-for="series in seriesGroups"
        :key="series.id"
        class="series-card series-card-expandable"
        :class="{ 'is-expanded': expandedSeriesId === series.id }"
        @click="toggleSeries(series.id)"
      >
        <p class="series-meta">{{ series.docs.length }} posts / latest {{ series.latest.displayDate }}</p>
        <div class="series-card-head">
          <h2 class="series-title">{{ series.title }}</h2>
          <span class="series-toggle">{{ expandedSeriesId === series.id ? "Close" : "Open" }}</span>
        </div>
        <p class="series-summary">{{ series.description }}</p>
        <div class="series-links" @click.stop>
          <RouterLink :to="series.first.path" class="series-link">Start from #1</RouterLink>
          <RouterLink :to="series.latest.path" class="series-link is-muted">Latest entry</RouterLink>
        </div>

        <div v-if="expandedSeriesId === series.id" class="series-docs-panel" @click.stop>
          <div class="series-docs-list">
            <article v-for="doc in getPagedDocs(series)" :key="doc.id" class="series-doc-item">
              <p class="article-meta">{{ doc.displayDate }} / {{ doc.yearMonth }}</p>
              <h3 class="article-title">
                <RouterLink :to="doc.path">{{ doc.title }}</RouterLink>
              </h3>
              <p class="article-excerpt">{{ doc.excerpt }}</p>
            </article>
          </div>

          <nav
            v-if="getSeriesPageCount(series) > 1"
            class="pagination series-pagination"
            aria-label="Series pagination"
          >
            <button
              class="pagination-button"
              :disabled="(currentPages[series.id] ?? 1) <= 1"
              @click="changeSeriesPage(series.id, (currentPages[series.id] ?? 1) - 1, getSeriesPageCount(series))"
            >
              Previous
            </button>
            <span class="pagination-status">
              {{ currentPages[series.id] ?? 1 }} / {{ getSeriesPageCount(series) }}
            </span>
            <button
              class="pagination-button"
              :disabled="(currentPages[series.id] ?? 1) >= getSeriesPageCount(series)"
              @click="changeSeriesPage(series.id, (currentPages[series.id] ?? 1) + 1, getSeriesPageCount(series))"
            >
              Next
            </button>
          </nav>
        </div>
      </article>
    </div>
  </section>
</template>

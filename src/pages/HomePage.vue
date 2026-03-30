<script setup>
import { RouterLink } from "vue-router";
import { getLatestDocs, getSeriesCollections } from "../lib/docs";

const latestDocs = getLatestDocs(3);
const seriesGroups = getSeriesCollections();
</script>

<template>
  <section class="page-card">
    <p class="page-label">Home</p>
    <h1 class="page-title">Hello World!</h1>
    <p class="page-description">
      実装しながら考えたこと、ハマったこと、設計の整理を少しずつ積み上げていく個人技術サイトです。
    </p>

    <section class="home-section">
      <div class="section-heading">
        <p class="section-kicker">Series</p>
        <h2 class="section-title">シリーズ</h2>
      </div>

      <div class="series-grid">
        <article v-for="series in seriesGroups.slice(0, 1)" :key="series.id" class="series-card">
          <p class="series-meta">{{ series.docs.length }} posts / latest {{ series.latest.displayDate }}</p>
          <h3 class="series-title">{{ series.title }}</h3>
          <p class="series-summary">
            {{ series.description }}
          </p>
          <div class="series-links">
            <RouterLink :to="series.first.path" class="series-link">Start from #1</RouterLink>
            <RouterLink to="/series" class="series-link is-muted">More series</RouterLink>
          </div>
        </article>
      </div>
    </section>

    <section class="home-section">
      <div class="section-heading">
        <p class="section-kicker">Latest</p>
        <h2 class="section-title">最新の更新</h2>
      </div>

      <div class="article-stack">
        <article v-for="doc in latestDocs" :key="doc.id" class="article-card">
          <p class="article-meta">{{ doc.displayDate }} / {{ doc.yearMonth }}</p>
          <h3 class="article-title">
            <RouterLink :to="doc.path">{{ doc.title }}</RouterLink>
          </h3>
          <p class="article-excerpt">{{ doc.excerpt }}</p>
        </article>
      </div>
    </section>
  </section>
</template>

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

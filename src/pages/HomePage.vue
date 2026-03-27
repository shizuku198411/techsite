<script setup>
import { RouterLink } from "vue-router";
import { getLatestDocs } from "../lib/docs";

const latestDocs = getLatestDocs(5);
</script>

<template>
  <section class="page-card">
    <p class="page-label">Home</p>
    <h1 class="page-title">Latest Docs</h1>

    <div class="article-stack">
      <article v-for="doc in latestDocs" :key="doc.id" class="article-card">
        <p class="article-meta">{{ doc.date }} / {{ doc.yearMonth }}</p>
        <h2 class="article-title">
          <RouterLink :to="doc.path">{{ doc.title }}</RouterLink>
        </h2>
        <p class="article-excerpt">{{ doc.excerpt }}</p>
      </article>
    </div>
  </section>
</template>

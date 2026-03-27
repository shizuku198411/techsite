<script setup>
import { ref, watch } from "vue";
import { RouterLink, RouterView, useRoute, useRouter } from "vue-router";

const route = useRoute();
const router = useRouter();

const navigationItems = [
  { label: "Home", to: "/" },
  { label: "Docs", to: "/docs" },
  { label: "About", to: "/about" },
  { label: "Privacy", to: "/privacy" },
  { label: "Contact", to: "/contact" },
];

const searchMode = ref("text");
const searchQuery = ref("");

watch(
  () => route.query,
  (query) => {
    searchMode.value = query.mode === "tag" ? "tag" : "text";
    searchQuery.value = typeof query.q === "string" ? query.q : "";
  },
  { immediate: true },
);

function submitSearch() {
  const query = {};

  if (searchQuery.value.trim()) {
    query.q = searchQuery.value.trim();
    query.mode = searchMode.value;
  }

  router.push({
    path: "/docs",
    query,
  });
}
</script>

<template>
  <div class="site-shell">
    <aside class="sidebar">
      <div class="sidebar-inner">
        <RouterLink class="site-title" to="/">Tech Docs</RouterLink>
        <p class="site-summary">
          雫の個人的技術サイト
        </p>

        <nav class="side-nav" aria-label="Primary">
          <RouterLink
            v-for="item in navigationItems"
            :key="item.to"
            :to="item.to"
            class="side-nav-link"
            :class="{ 'is-active': route.path === item.to || (item.to === '/docs' && route.path.startsWith('/docs')) }"
          >
            {{ item.label }}
          </RouterLink>
        </nav>

        <form class="search-panel" @submit.prevent="submitSearch">
          <select id="site-search-mode" v-model="searchMode" class="search-select">
            <option value="text">Keyword</option>
            <option value="tag">Tags</option>
          </select>
          <input
            id="site-search-input"
            v-model="searchQuery"
            class="search-input"
            type="search"
            :placeholder="searchMode === 'tag' ? 'tag name' : 'keyword'"
          />
          <button class="search-button" type="submit">Search</button>
        </form>
      </div>
    </aside>

    <main class="content-shell">
      <RouterView />
    </main>
  </div>
</template>

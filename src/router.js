import { createRouter, createWebHistory } from "vue-router";
import HomePage from "./pages/HomePage.vue";
import DocsPage from "./pages/DocsPage.vue";
import DocArticlePage from "./pages/DocArticlePage.vue";
import SeriesPage from "./pages/SeriesPage.vue";
import AboutPage from "./pages/AboutPage.vue";
import PrivacyPage from "./pages/PrivacyPage.vue";
import ContactPage from "./pages/ContactPage.vue";

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: "/", component: HomePage },
    { path: "/docs", component: DocsPage },
    { path: "/docs/:yearMonth/:slug", component: DocArticlePage, props: true },
    { path: "/series", component: SeriesPage },
    { path: "/about", component: AboutPage },
    { path: "/privacy", component: PrivacyPage },
    { path: "/contact", component: ContactPage },
  ],
  scrollBehavior() {
    return { top: 0 };
  },
});

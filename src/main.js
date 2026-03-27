import { createApp } from "vue";
import "highlight.js/styles/github-dark.min.css";
import App from "./App.vue";
import { router } from "./router";
import "./style.css";

createApp(App).use(router).mount("#app");

function parseFrontMatter(source) {
  const normalized = source.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { metadata: {}, body: normalized };
  }

  const endIndex = normalized.indexOf("\n---\n", 4);
  if (endIndex === -1) {
    return { metadata: {}, body: normalized };
  }

  const frontMatter = normalized.slice(4, endIndex);
  const body = normalized.slice(endIndex + 5).trim();
  const metadata = {};

  for (const line of frontMatter.split("\n")) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    metadata[key] = value;
  }

  return { metadata, body };
}

function slugify(value) {
  return value
    .toLocaleLowerCase()
    .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderInline(value) {
  const parts = value.split(/(`[^`]+`)/g);
  return parts
    .map((part) => {
      if (part.startsWith("`") && part.endsWith("`") && part.length >= 2) {
        return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      }

      const escaped = escapeHtml(part);
      return escaped.replace(
        /\[([^\]]+)\]\(([^)]+)\)/g,
        (_match, label, href) =>
          `<a href="${href}" target="_blank" rel="noreferrer">${label}</a>`,
      );
    })
    .join("");
}

function renderMarkdown(markdown) {
  const lines = markdown.split("\n");
  const html = [];
  const headings = [];
  let inList = false;
  let inBlockquote = false;
  let inCodeBlock = false;
  let codeLanguage = "";
  let codeLines = [];
  let h2Count = 0;
  let h3Count = 0;

  const closeList = () => {
    if (inList) {
      html.push("</ul>");
      inList = false;
    }
  };

  const closeBlockquote = () => {
    if (inBlockquote) {
      html.push("</blockquote>");
      inBlockquote = false;
    }
  };

  for (const line of lines) {
    if (line.startsWith("```")) {
      closeList();
      closeBlockquote();
      if (inCodeBlock) {
        const languageClass = codeLanguage ? ` class="language-${codeLanguage}"` : "";
        html.push(
          `<pre class="code-block"><code${languageClass}>${codeLines.join("\n")}</code></pre>`,
        );
        codeLanguage = "";
        codeLines = [];
      } else {
        codeLanguage = line.slice(3).trim();
      }
      inCodeBlock = !inCodeBlock;
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(
        line
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;"),
      );
      continue;
    }

    if (!line.trim()) {
      closeList();
      closeBlockquote();
      continue;
    }

    if (line.startsWith("> ")) {
      closeList();
      if (!inBlockquote) {
        html.push("<blockquote>");
        inBlockquote = true;
      }
      html.push(`<p>${renderInline(line.slice(2))}</p>`);
      continue;
    }

    closeBlockquote();

    if (line.startsWith("### ")) {
      closeList();
      const title = line.slice(4).trim();
      h3Count += 1;
      const numbering = h2Count > 0 ? `${h2Count}.${h3Count}` : `0.${h3Count}`;
      const id = slugify(`${numbering}-${title}`);
      headings.push({ level: 3, title, numbering, id });
      html.push(
        `<h3 id="${id}"><a class="heading-anchor" href="#${id}">${numbering} ${renderInline(title)}</a></h3>`,
      );
      continue;
    }

    if (line.startsWith("## ")) {
      closeList();
      const title = line.slice(3).trim();
      h2Count += 1;
      h3Count = 0;
      const numbering = `${h2Count}`;
      const id = slugify(`${numbering}-${title}`);
      headings.push({ level: 2, title, numbering, id });
      html.push(
        `<h2 id="${id}"><a class="heading-anchor" href="#${id}">${numbering}. ${renderInline(title)}</a></h2>`,
      );
      continue;
    }

    if (line.startsWith("- ")) {
      if (!inList) {
        html.push("<ul>");
        inList = true;
      }
      html.push(`<li>${renderInline(line.slice(2))}</li>`);
      continue;
    }

    closeList();
    html.push(`<p>${renderInline(line)}</p>`);
  }

  closeList();
  closeBlockquote();

  if (inCodeBlock) {
    const languageClass = codeLanguage ? ` class="language-${codeLanguage}"` : "";
    html.push(
      `<pre class="code-block"><code${languageClass}>${codeLines.join("\n")}</code></pre>`,
    );
  }

  return {
    html: html.join("\n"),
    headings,
  };
}

const docModules = import.meta.glob("../../docs/*/*.md", {
  eager: true,
  query: "?raw",
  import: "default",
});

export const docs = Object.entries(docModules)
  .map(([path, source]) => {
    const { metadata, body } = parseFrontMatter(source);
    const rendered = renderMarkdown(body);
    const [, yearMonth, fileName] = path.match(/docs\/([^/]+)\/([^/]+)\.md$/) ?? [];
    const slug = fileName;
    const date = metadata.date ?? `${yearMonth}-01`;

    return {
      id: `${yearMonth}/${slug}`,
      yearMonth,
      slug,
      title: metadata.title ?? slug,
      date,
      excerpt: metadata.excerpt ?? "",
      tags: metadata.tags ? metadata.tags.split(",").map((item) => item.trim()) : [],
      body,
      html: rendered.html,
      headings: rendered.headings,
      path: `/docs/${yearMonth}/${slug}`,
    };
  })
  .sort((left, right) => right.date.localeCompare(left.date));

export function getLatestDocs(count) {
  return docs.slice(0, count);
}

export function getPagedDocs(page, pageSize) {
  const startIndex = (page - 1) * pageSize;
  return docs.slice(startIndex, startIndex + pageSize);
}

export function getDocByParams(yearMonth, slug) {
  return docs.find((entry) => entry.yearMonth === yearMonth && entry.slug === slug);
}

export function filterDocs(mode, query) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) {
    return docs;
  }

  if (mode === "tag") {
    return docs.filter((entry) =>
      entry.tags.some((tag) => tag.toLocaleLowerCase().includes(normalizedQuery)),
    );
  }

  return docs.filter((entry) => {
    const title = entry.title.toLocaleLowerCase();
    const body = entry.body.toLocaleLowerCase();
    return title.includes(normalizedQuery) || body.includes(normalizedQuery);
  });
}

export function getTotalPages(pageSize, entries = docs) {
  return Math.max(1, Math.ceil(entries.length / pageSize));
}

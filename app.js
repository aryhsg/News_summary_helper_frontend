// ---------------------------------------------------------------------------
// News Summary Helper — frontend app logic.
// Vanilla JS, no framework, no build step. Talks to the FastAPI backend
// described in config.js (API_BASE / API_KEY).
// ---------------------------------------------------------------------------

const CATEGORIES = [
  "要聞", "國際", "證券", "期貨", "理財", "房市",
  "兩岸", "金融", "專欄", "專題", "商情", "產業",
];

// The category-level summary endpoint technically accepts any category
// string (it just answers "該類別尚無摘要" if nothing has been generated
// yet), so every category stays clickable — this subset is only used to
// give the user a heads-up in the UI about which ones are actually
// populated today.
const CATEGORY_SUMMARY_POPULATED = new Set(["要聞", "國際", "證券", "期貨", "產業", "金融"]);

const state = {
  allNews: [],            // last successfully loaded list (real or sandbox)
  displayedNews: [],      // allNews after search + category filter
  activeCategory: null,   // null = "all"
  searchQuery: "",
  sandboxMode: false,
  currentArticle: null,   // full article detail currently open in the panel
  summaryCache: new Map(),         // `${mode}:${id}` -> summary html
  categorySummaryCache: new Map(), // `${category}` -> summary html / plain note
  searchDebounceTimer: null,
  searchRequestSeq: 0,    // guards against out-of-order async search responses
};

// ---------------------------------------------------------------------------
// API helper
// ---------------------------------------------------------------------------

class ApiError extends Error {
  constructor(type, message) {
    super(message);
    this.type = type; // 'auth' | 'not_found' | 'service_down' | 'network' | 'unknown'
  }
}

async function apiRequest(path, options = {}) {
  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        "X-API-KEY": API_KEY,
        "Accept": "application/json",
        ...(options.headers || {}),
      },
    });
  } catch (networkErr) {
    throw new ApiError(
      "network",
      "無法連線到後端伺服器。請確認 API_BASE 設定正確、後端是否正在執行；" +
      "若是在本機用不同連接埠開啟本頁與後端，瀏覽器可能因為沒有設定 CORS 而擋下請求（這是後端設定的問題，不是這個前端的 bug）。"
    );
  }

  if (res.status === 403) {
    throw new ApiError("auth", "API 金鑰驗證失敗，請確認 config.js 裡的 API_KEY 是否填寫正確。");
  }
  if (res.status === 404) {
    let detail = "找不到資料。";
    try { detail = (await res.json()).detail || detail; } catch (_) {}
    throw new ApiError("not_found", detail);
  }
  if (res.status === 503) {
    let detail = "資料庫暫時無法使用，請稍後再試。";
    try { detail = (await res.json()).detail || detail; } catch (_) {}
    throw new ApiError("service_down", detail);
  }
  if (!res.ok) {
    let detail = `伺服器發生錯誤（HTTP ${res.status}）。`;
    try { detail = (await res.json()).detail || detail; } catch (_) {}
    throw new ApiError("unknown", detail);
  }

  return res.json();
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function init() {
  renderSidebar();
  wireEvents();
  loadNewsList();
}

function wireEvents() {
  document.getElementById("sandboxToggle").addEventListener("change", onSandboxToggle);
  document.getElementById("searchInput").addEventListener("input", onSearchInput);
  document.getElementById("categorySummaryBtn").addEventListener("click", onCategorySummaryClick);
  document.getElementById("articleClose").addEventListener("click", closeArticlePanel);
  document.getElementById("articleOverlay").addEventListener("click", closeArticlePanel);
  document.getElementById("categoryClose").addEventListener("click", closeCategoryModal);
  document.getElementById("categoryOverlay").addEventListener("click", closeCategoryModal);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    closeArticlePanel();
    closeCategoryModal();
  });
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

function renderSidebar() {
  const nav = document.getElementById("navScroll");
  const allActive = state.activeCategory === null ? "active" : "";
  let html = `
    <button class="nav-item ${allActive}" data-category="" type="button">
      <span>所有新聞</span>
      <span class="nav-count" id="nav-count-all">0</span>
    </button>
    <div class="nav-divider">分類</div>
  `;
  CATEGORIES.forEach((cat) => {
    const active = state.activeCategory === cat ? "active" : "";
    html += `
      <button class="nav-item ${active}" data-category="${cat}" type="button">
        <span>${cat}</span>
        <span class="nav-count" id="nav-count-${cat}">0</span>
      </button>
    `;
  });
  nav.innerHTML = html;

  nav.querySelectorAll(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => setActiveCategory(btn.dataset.category || null));
  });

  updateNavCounts();
}

function updateNavCounts() {
  const allCountEl = document.getElementById("nav-count-all");
  if (allCountEl) allCountEl.textContent = state.allNews.length;
  CATEGORIES.forEach((cat) => {
    const el = document.getElementById(`nav-count-${cat}`);
    if (el) el.textContent = state.allNews.filter((n) => n.category === cat).length;
  });
}

function setActiveCategory(cat) {
  state.activeCategory = cat || null;
  renderSidebar();
  updatePageTitle();
  applyFiltersAndRender();
}

function updatePageTitle() {
  document.getElementById("pageTitle").textContent = state.activeCategory || "所有新聞";
}

// ---------------------------------------------------------------------------
// Sandbox mode
// ---------------------------------------------------------------------------

function onSandboxToggle(e) {
  state.sandboxMode = e.target.checked;
  state.summaryCache.clear();
  document.getElementById("categorySummaryBtn").disabled = state.sandboxMode;
  document.getElementById("categorySummaryBtn").title = state.sandboxMode
    ? "示範模式沒有分類摘要端點，僅提供單篇文章摘要"
    : "針對目前分類生成趨勢摘要";
  showToast(state.sandboxMode ? "已切換至示範模式（不耗用 AI 配額）" : "已切換回正式資料");
  loadNewsList();
}

// ---------------------------------------------------------------------------
// News list loading / filtering
// ---------------------------------------------------------------------------

async function loadNewsList() {
  const grid = document.getElementById("newsGrid");
  showState(grid, `<div class="state-box"><span class="spinner"></span></div>`);
  clearStatusBanner();

  const path = state.sandboxMode ? "/api/sandbox/news" : "/api/news";
  try {
    const news = await apiRequest(path);
    state.allNews = news;
    updateNavCounts();
    applyFiltersAndRender();
  } catch (err) {
    state.allNews = [];
    updateNavCounts();
    showStatusBanner(err);
    showState(grid, `<div class="state-box">目前無法載入新聞列表。</div>`);
  }
}

function onSearchInput(e) {
  state.searchQuery = e.target.value.trim();
  clearTimeout(state.searchDebounceTimer);
  state.searchDebounceTimer = setTimeout(() => applyFiltersAndRender(), 350);
}

async function applyFiltersAndRender() {
  const mySeq = ++state.searchRequestSeq;
  const grid = document.getElementById("newsGrid");

  let base = state.allNews;

  if (state.searchQuery) {
    if (state.sandboxMode) {
      // No sandbox-scoped search endpoint is documented, so in demo mode we
      // just filter the already-loaded (small, fixed) sandbox list locally.
      base = state.allNews.filter((n) => n.title.includes(state.searchQuery));
    } else {
      showState(grid, `<div class="state-box"><span class="spinner"></span></div>`);
      try {
        base = await apiRequest(`/api/news/search?q=${encodeURIComponent(state.searchQuery)}`);
      } catch (err) {
        if (mySeq !== state.searchRequestSeq) return; // a newer search superseded this one
        showStatusBanner(err);
        showState(grid, `<div class="state-box">搜尋時發生錯誤。</div>`);
        return;
      }
      if (mySeq !== state.searchRequestSeq) return;
    }
  } else {
    clearStatusBanner();
  }

  const filtered = state.activeCategory
    ? base.filter((n) => n.category === state.activeCategory)
    : base;

  state.displayedNews = filtered;
  renderGrid();
}

function renderGrid() {
  const grid = document.getElementById("newsGrid");
  if (state.displayedNews.length === 0) {
    const msg = state.searchQuery ? "找不到符合搜尋條件的新聞，換個關鍵字試試。" : "這個分類目前沒有新聞。";
    showState(grid, `<div class="state-box"><img class="state-mark" src="nsh-logo3.png" alt="">${msg}</div>`);
    return;
  }

  // Alternates orange/blue by position — a deterministic rhythm (not a
  // random per-card roll) echoing the two-tone paper shards in the logo.
  grid.innerHTML = state.displayedNews.map((n, i) => {
    const isBlue = i % 2 === 1;
    return `
    <button class="news-card" type="button" data-id="${escapeAttr(n.id)}">
      <div class="card-thumb">
        ${n.img ? `<img src="${escapeAttr(n.img)}" alt="" loading="lazy" onerror="this.remove()">` : ""}
        <span class="card-flag${isBlue ? " is-blue" : ""}" aria-hidden="true"></span>
      </div>
      <div class="card-body">
        <h3 class="card-title">${escapeHtml(n.title)}</h3>
        <span class="card-tag${isBlue ? " is-blue" : ""}">${escapeHtml(n.category)}</span>
      </div>
    </button>
  `;
  }).join("");

  grid.querySelectorAll(".news-card").forEach((card) => {
    card.addEventListener("click", () => openArticlePanel(card.dataset.id));
  });
}

function showState(container, html) {
  container.innerHTML = html;
}

// ---------------------------------------------------------------------------
// Article detail panel
// ---------------------------------------------------------------------------

async function openArticlePanel(id) {
  const overlay = document.getElementById("articleOverlay");
  const panel = document.getElementById("articlePanel");
  const body = document.getElementById("articleBody");

  overlay.hidden = false;
  panel.hidden = false;
  document.getElementById("articleCat").textContent = "載入中…";
  body.innerHTML = `<div class="state-box"><span class="spinner"></span></div>`;

  try {
    const article = await apiRequest(`/api/news/${encodeURIComponent(id)}`);
    state.currentArticle = article;
    renderArticlePanel(article);
  } catch (err) {
    document.getElementById("articleCat").textContent = "讀取失敗";
    body.innerHTML = `<div class="state-box">${escapeHtml(err.message)}</div>`;
  }
}

function renderArticlePanel(article) {
  document.getElementById("articleCat").textContent = article.category;

  const paragraphs = (article.content || "")
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p)}</p>`)
    .join("");

  const cacheKey = `${state.sandboxMode ? "sandbox" : "real"}:${article.id}`;
  const cachedSummary = state.summaryCache.get(cacheKey);

  document.getElementById("articleBody").innerHTML = `
    ${article.img ? `<img class="article-img" src="${escapeAttr(article.img)}" alt="" onerror="this.remove()">` : ""}
    <h2 class="article-title">${escapeHtml(article.title)}</h2>
    <div class="article-content">${paragraphs || "<p>（本文沒有內容）</p>"}</div>
    <div class="summary-section">
      <button class="btn btn-primary" id="btnGenerateSummary" type="button">
        ${cachedSummary ? "重新查看 AI 摘要" : "生成 AI 摘要"}
      </button>
      <div id="summaryContainer">${cachedSummary ? `<div class="summary-box">${cachedSummary}</div>` : ""}</div>
    </div>
  `;

  document.getElementById("btnGenerateSummary").addEventListener("click", () => generateArticleSummary(article.id));
}

async function generateArticleSummary(id) {
  const btn = document.getElementById("btnGenerateSummary");
  const container = document.getElementById("summaryContainer");
  const cacheKey = `${state.sandboxMode ? "sandbox" : "real"}:${id}`;

  const cached = state.summaryCache.get(cacheKey);
  if (cached) {
    container.innerHTML = `<div class="summary-box">${cached}</div>`;
    return;
  }

  btn.disabled = true;
  container.innerHTML = `<div class="state-box"><span class="spinner"></span><br>AI 正在生成摘要，第一次產生可能需要較長時間…</div>`;

  const path = state.sandboxMode
    ? `/api/sandbox/news/${encodeURIComponent(id)}/summary`
    : `/api/news/${encodeURIComponent(id)}/summary`;

  try {
    const result = await apiRequest(path, { method: "POST" });
    state.summaryCache.set(cacheKey, result.summary);
    container.innerHTML = `<div class="summary-box">${result.summary}</div>`;
    btn.textContent = "重新查看 AI 摘要";
  } catch (err) {
    container.innerHTML = `<div class="state-box">${escapeHtml(err.message)}</div>`;
  } finally {
    btn.disabled = false;
  }
}

function closeArticlePanel() {
  document.getElementById("articleOverlay").hidden = true;
  document.getElementById("articlePanel").hidden = true;
  state.currentArticle = null;
}

// ---------------------------------------------------------------------------
// Category summary modal
// ---------------------------------------------------------------------------

async function onCategorySummaryClick() {
  if (state.sandboxMode) return; // no endpoint for this in demo mode
  const category = state.activeCategory;
  if (!category) {
    showToast("請先從左側選擇一個分類");
    return;
  }
  openCategoryModal(category);
}

async function openCategoryModal(category) {
  const overlay = document.getElementById("categoryOverlay");
  const modal = document.getElementById("categoryModal");
  const body = document.getElementById("categoryModalBody");

  document.getElementById("categoryModalTitle").textContent = `${category}的趨勢摘要`;
  overlay.hidden = false;
  modal.hidden = false;

  const cached = state.categorySummaryCache.get(category);
  if (cached) {
    renderCategorySummaryResult(category, cached);
    return;
  }

  body.innerHTML = `<div class="state-box"><span class="spinner"></span><br>AI 正在整理「${escapeHtml(category)}」這幾天的新聞趨勢…</div>`;

  try {
    const result = await apiRequest(`/api/news/summary/${encodeURIComponent(category)}`, { method: "POST" });
    state.categorySummaryCache.set(category, result.summary);
    renderCategorySummaryResult(category, result.summary);
  } catch (err) {
    body.innerHTML = `<div class="state-box">${escapeHtml(err.message)}</div>`;
  }
}

function renderCategorySummaryResult(category, summary) {
  const body = document.getElementById("categoryModalBody");
  if (summary === "該類別尚無摘要") {
    const hint = CATEGORY_SUMMARY_POPULATED.has(category)
      ? "稍後再回來看看，或是先生成其他新聞的摘要。"
      : "目前固定生成趨勢摘要的分類是要聞、國際、證券、期貨、產業、金融，其他分類通常還沒有累積到可以生成摘要。";
    body.innerHTML = `<p class="summary-empty-note">AI 還沒有針對「${escapeHtml(category)}」生成趨勢摘要。${hint}</p>`;
  } else {
    body.innerHTML = summary;
  }
}

function closeCategoryModal() {
  document.getElementById("categoryOverlay").hidden = true;
  document.getElementById("categoryModal").hidden = true;
}

// ---------------------------------------------------------------------------
// Status banner + toast
// ---------------------------------------------------------------------------

function showStatusBanner(err) {
  const banner = document.getElementById("statusBanner");
  banner.hidden = false;
  banner.textContent = err.message;
}

function clearStatusBanner() {
  const banner = document.getElementById("statusBanner");
  banner.hidden = true;
  banner.textContent = "";
}

let toastTimer = null;
function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(str) {
  return escapeHtml(str);
}

document.addEventListener("DOMContentLoaded", init);

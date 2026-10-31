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
  allNews: [],            // last successfully loaded list
  displayedNews: [],      // allNews after search + category filter
  activeCategory: null,   // null = "all"
  searchQuery: "",
  currentArticle: null,   // full article detail currently open in the panel
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
    // 給開發者的排查提示只寫進 console，畫面上只顯示一般使用者看得懂的訊息。
    console.error(
      "[apiRequest] 連線失敗：請確認 config.js 的 API_BASE 設定正確、後端是否正在執行；" +
      "若是在本機用不同連接埠開啟本頁與後端，瀏覽器可能因為沒有設定 CORS 而擋下請求。",
      networkErr
    );
    throw new ApiError("network", "無法連線到後端伺服器，請檢查網路連線後再試一次。");
  }

  if (res.status === 403) {
    console.error("[apiRequest] 403：請確認 config.js 裡的 API_KEY 與後端的 INTERNAL_API_KEY 一致。");
    throw new ApiError("auth", "API 金鑰驗證失敗，請重新整理頁面後再試；若持續發生請聯絡管理員。");
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
// News list loading / filtering
// ---------------------------------------------------------------------------

async function loadNewsList() {
  const grid = document.getElementById("newsGrid");
  showState(grid, `<div class="state-box"><span class="spinner"></span></div>`);
  clearStatusBanner();

  try {
    const news = await apiRequest("/api/news");
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

  // article.content 本身就是爬蟲留下的真實 HTML（<p>...</p>、<!--N--> 註解
  // 之類），不是純文字，所以要當 HTML 插入；用 escapeHtml 跳脫會讓真正
  // 的 <p> 標籤變成畫面上看得見的文字，而不是被瀏覽器解析成段落。但它來自
  // 外部網站，插入前一定要先過 sanitizeHtml 白名單清理。
  const content = sanitizeHtml(
    article.content && article.content.trim()
      ? article.content
      : "<p>（本文沒有內容）</p>"
  );

  // 每次打開文章一律從「還沒有摘要」的原始單欄狀態開始，不管這篇之前是否
  // 已經生成過摘要——是否已經有摘要存在資料庫，交給後端的
  // /api/news/{id}/summary 自己判斷（有的話直接回傳，不會重打 Gemini），
  // 前端不在這裡用自己的記憶體快取提前搶答、擅自跳過詢問後端。
  document.getElementById("articleBody").innerHTML = `
    <div class="article-title-row">
      <h2 class="article-title">${escapeHtml(article.title)}</h2>
      <button class="btn btn-primary" id="btnGenerateSummary" type="button">生成 AI 摘要</button>
    </div>
    ${article.img ? `<img class="article-img" src="${escapeAttr(article.img)}" alt="" onerror="this.remove()">` : ""}
    <div class="article-split">
      <div class="article-col-main">
        <div class="article-content">${content}</div>
      </div>
      <div class="article-col-summary" id="summaryColumn" hidden>
        <h3 class="summary-col-title">AI 摘要</h3>
        <div id="summaryContainer"></div>
      </div>
    </div>
  `;

  document.getElementById("articlePanel").classList.remove("is-split");
  document.getElementById("btnGenerateSummary").addEventListener("click", () => generateArticleSummary(article.id));
}

async function generateArticleSummary(id) {
  const btn = document.getElementById("btnGenerateSummary");
  const container = document.getElementById("summaryContainer");

  // Reveal the summary column and widen the dialog immediately on click
  // (even before the request resolves), so the loading state shows up
  // beside the article right away instead of popping in only on success.
  document.getElementById("summaryColumn").hidden = false;
  document.getElementById("articlePanel").classList.add("is-split");

  btn.disabled = true;
  container.innerHTML = `<div class="state-box"><span class="spinner"></span><br>AI 正在生成摘要，第一次產生可能需要較長時間…</div>`;

  const path = `/api/news/${encodeURIComponent(id)}/summary`;

  try {
    const result = await apiRequest(path, { method: "POST" });
    container.innerHTML = `<div class="summary-box">${sanitizeHtml(result.summary)}</div>`;
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
    // 「尚無摘要」不快取：之後後端產生了，同一個頁面再按一次就要看得到。
    // 這個端點只是對主鍵查一筆資料，每次重新請求的成本很低。
    if (result.summary !== "該類別尚無摘要") {
      state.categorySummaryCache.set(category, result.summary);
    }
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
    body.innerHTML = sanitizeHtml(summary);
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

// 新聞內文（爬蟲抓回的 HTML）與 AI 摘要（LLM 依外部新聞生成，後端沒有跳脫）都
// 是「我們不控制的 HTML」，一律先經過白名單清理才能放進 innerHTML，否則內文或
// 摘要裡的 <img onerror=...> 之類寫法會直接執行（XSS）。白名單依真實新聞內文與
// 摘要實際用到的標籤決定：排版、表格、圖片加圖說、連結；不放行 script、iframe、
// 表單類標籤，也不放行 on* 事件屬性與 javascript: 連結（DOMPurify 預設就會擋）。
const SANITIZE_CONFIG = {
  ALLOWED_TAGS: [
    "p", "br", "hr", "div", "span", "section", "strong", "b", "i", "em", "u", "font",
    "h2", "h3", "h4", "ul", "ol", "li", "blockquote",
    "table", "thead", "tbody", "tr", "th", "td",
    "figure", "figcaption", "img", "a",
  ],
  ALLOWED_ATTR: ["class", "style", "href", "target", "src", "alt", "title", "width", "height", "loading", "align"],
  ALLOW_DATA_ATTR: false,
};

if (typeof DOMPurify !== "undefined") {
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    // style 只保留 text-align（後端摘要的 <p style='text-align: justify;'> 會用到），
    // 其餘 CSS 一律移除，避免用樣式做版面覆蓋或外連。
    if (node.hasAttribute && node.hasAttribute("style")) {
      const m = node.getAttribute("style").match(/text-align\s*:\s*(left|right|center|justify)/i);
      if (m) node.setAttribute("style", `text-align: ${m[1].toLowerCase()}`);
      else node.removeAttribute("style");
    }
    // 另開分頁的連結不要讓新頁面能操作原頁面
    if (node.tagName === "A" && node.getAttribute("target") === "_blank") {
      node.setAttribute("rel", "noopener noreferrer");
    }
  });
}

function sanitizeHtml(dirty) {
  // 清理工具沒載入時寧可顯示成純文字，也不要原樣當 HTML 插入。
  if (typeof DOMPurify === "undefined") return escapeHtml(dirty);
  return DOMPurify.sanitize(String(dirty), SANITIZE_CONFIG);
}

document.addEventListener("DOMContentLoaded", init);

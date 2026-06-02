console.log("✅ IG content script loaded!");

let __igScrapeRunning = false;
let __activeRunId = null;
let __stopRequested = false;

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.action === "scrape") {
    if (__igScrapeRunning) {
      console.log("⚠️ Scraper already running; ignoring new request.");
      return;
    }

    __igScrapeRunning = true;
    __activeRunId = msg.runId;
    __stopRequested = false;

    scrapeInstagramComments(msg.runId)
      .catch((e) => {
        console.error("❌ Scrape failed:", e);
        chrome.runtime.sendMessage({
          type: "error",
          runId: msg.runId,
          message: String(e?.message || e),
        });
      })
      .finally(() => {
        __igScrapeRunning = false;
        __activeRunId = null;
        __stopRequested = false;
      });
  }

  if (msg?.action === "stop") {
    if (__igScrapeRunning && __activeRunId && msg.runId === __activeRunId) {
      console.log("🛑 Stop requested by user.");
      __stopRequested = true;
    }
  }
});

async function scrapeInstagramComments(runId) {
  const CFG = {
    SCROLL_STEP_PX: 900,

    BASE_SETTLE_MS: 1200,
    MAX_SETTLE_MS: 9000,
    EXTRA_RESCAN_WAIT_MS: 1800,

    BASE_IDLE_ROUNDS_BEFORE_STOP: 18,
    MAX_ROUNDS: 9000,

    STUCK_ROUNDS_BEFORE_STOP: 3,
  };

  const sleepInterruptible = async (msTotal) => {
    const step = 120;
    let left = msTotal;
    while (left > 0) {
      if (__stopRequested) return;
      const cur = Math.min(step, left);
      await new Promise((r) => setTimeout(r, cur));
      left -= cur;
    }
  };

  function normalizeWs(s) {
    return (s ?? "").replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();
  }

  function getInstagramPathname(href) {
    if (!href) return "";

    try {
      const url = new URL(href, location.href);
      const host = (url.hostname || "").replace(/^www\./, "").toLowerCase();
      if (host && host !== "instagram.com") return "";
      return url.pathname || "";
    } catch {
      return String(href || "");
    }
  }

  function handleFromProfileHref(href) {
    const path = getInstagramPathname(href);
    const parts = path.split("/").filter(Boolean);
    if (parts.length !== 1) return "";

    const handle = decodeURIComponent(parts[0]).replace(/^@/, "").trim();
    if (!handle) return "";

    // Exclude Instagram sections that can also look like /something/.
    const reserved = new Set([
      "about",
      "accounts",
      "api",
      "direct",
      "developer",
      "explore",
      "legal",
      "p",
      "privacy",
      "reel",
      "reels",
      "stories",
      "terms",
      "tv",
      "web",
    ]);

    if (reserved.has(handle.toLowerCase())) return "";
    return handle;
  }

  function isProfileAnchor(a) {
    return !!handleFromProfileHref(a?.getAttribute?.("href") || a?.href || "");
  }

  function profileAnchors(scope = document) {
    return Array.from(scope.querySelectorAll('a[href]')).filter(isProfileAnchor);
  }

  function getAnchorHandle(a) {
    return handleFromProfileHref(a?.getAttribute?.("href") || a?.href || "");
  }

  function cleanHandleText(text, fallback = "") {
    const t = normalizeWs(text).replace(/^@/, "");
    if (!t) return fallback;

    // Header/profile links can include badge text in saved pages, e.g. "name Verified".
    return t.replace(/\s+Verified$/i, "").trim() || fallback;
  }

  function handleFromPostUrl(urlish) {
    const path = getInstagramPathname(urlish);
    const parts = path.split("/").filter(Boolean);
    // Saved pages may use /owner/p/shortcode/, while live pages are often /p/shortcode/.
    if (parts.length >= 3 && parts[1] === "p") return handleFromProfileHref(`/${parts[0]}/`);
    return "";
  }

  function parseAbbrevNumber(raw) {
    const s = normalizeWs(raw).toLowerCase();
    if (!s) return 0;

    const token = s.split(" ")[0].replace(/,/g, "");
    if (!token) return 0;

    const m = token.match(/^(\d+(\.\d+)?)([km])?$/i);
    if (!m) {
      const digits = token.replace(/[^\d]/g, "");
      return digits ? parseInt(digits, 10) : 0;
    }

    const base = parseFloat(m[1]);
    const suffix = (m[3] || "").toLowerCase();
    if (suffix === "k") return Math.round(base * 1000);
    if (suffix === "m") return Math.round(base * 1000000);
    return Math.round(base);
  }

  function isScrollable(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    const oy = style.overflowY;
    return (oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 20;
  }

  function findScrollTarget(mount) {
    let el = mount;
    for (let i = 0; i < 25 && el; i++) {
      if (isScrollable(el)) return el;
      el = el.parentElement;
    }
    return null;
  }

  // -------------------------
  // ✅ Metadata (A/B/C)
  // -------------------------

  function extractPublisher() {
    let handle =
      handleFromPostUrl(document.querySelector('meta[property="og:url"]')?.content || "") ||
      handleFromPostUrl(document.querySelector('link[rel="canonical"]')?.href || "") ||
      handleFromPostUrl(location.href || "");

    if (!handle) {
      const title =
        document.querySelector('meta[name="twitter:title"]')?.content ||
        document.querySelector('meta[property="og:title"]')?.content ||
        document.title ||
        "";
      const m = title.match(/@([A-Za-z0-9._]+)/);
      if (m) handle = m[1];
    }

    if (!handle) {
      const withPostTime = profileAnchors(document).find((a) => {
        for (let el = a; el; el = el.parentElement) {
          const time = el.querySelector?.('time[datetime]');
          if (!time) continue;
          const timeLink = time.closest?.('a[href*="/c/"]');
          if (!timeLink) return true;
        }
        return false;
      });

      const firstProfile = withPostTime || profileAnchors(document)[0];
      if (firstProfile) handle = getAnchorHandle(firstProfile);
    }

    handle = cleanHandleText(handle);
    const url = handle ? `https://www.instagram.com/${handle}/` : "N/A";
    const nickname = handle || "N/A";

    return { nickname, handle: handle || "N/A", url };
  }

  function formatIsoToNowStyle(iso) {
    if (!iso) return "N/A";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "N/A";
    return d.toString();
  }

  function findCaptionTimeNearPublisherHandle(handle) {
    if (!handle || handle === "N/A") return null;

    const anchors = profileAnchors(document).filter((a) => getAnchorHandle(a).toLowerCase() === handle.toLowerCase());

    // Prefer the caption/post timestamp, not the publisher replying in their own comments.
    for (const a of anchors) {
      let el = a;
      for (let i = 0; i < 18 && el; i++, el = el.parentElement) {
        const t = el.querySelector?.("time[datetime]") || null;
        if (!t) continue;
        if (!t.closest?.('a[href*="/c/"]')) return t;
      }
    }

    for (const a of anchors) {
      let el = a;
      for (let i = 0; i < 18 && el; i++, el = el.parentElement) {
        const t = el.querySelector?.("time[datetime]") || null;
        if (t) return t;
      }
    }

    return null;
  }

  function tryExtractPostPublishTimeOnce(publisherHandle) {
    const tNear = findCaptionTimeNearPublisherHandle(publisherHandle);
    if (tNear) {
      const iso = tNear.getAttribute("datetime") || "";
      const formatted = formatIsoToNowStyle(iso);
      if (formatted !== "N/A") return formatted;
    }

    const allTimes = Array.from(document.querySelectorAll("time[datetime]"))
      .map((t) => ({ iso: t.getAttribute("datetime") || "" }))
      .filter((x) => x.iso)
      .map((x) => ({ ...x, ms: new Date(x.iso).getTime() }))
      .filter((x) => Number.isFinite(x.ms))
      .sort((a, b) => a.ms - b.ms);

    if (allTimes.length) return formatIsoToNowStyle(allTimes[0].iso);

    const metaIso =
      document.querySelector('meta[property="article:published_time"]')?.content ||
      document.querySelector('meta[property="og:updated_time"]')?.content ||
      document.querySelector('meta[name="publication_date"]')?.content ||
      "";

    const metaFormatted = formatIsoToNowStyle(metaIso);
    if (metaFormatted !== "N/A") return metaFormatted;

    const ld = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
      .map((s) => (s.textContent || "").trim())
      .filter(Boolean);

    for (const raw of ld) {
      try {
        const data = JSON.parse(raw);
        const items = Array.isArray(data) ? data : [data];

        for (const it of items) {
          const iso =
            it?.uploadDate ||
            it?.datePublished ||
            it?.dateCreated ||
            it?.publicationDate ||
            "";

          const formatted = formatIsoToNowStyle(iso);
          if (formatted !== "N/A") return formatted;
        }
      } catch {
        // ignore
      }
    }

    return "N/A";
  }

  async function extractPostPublishTime(publisherHandle) {
    const timeoutMs = 8000;
    const stepMs = 250;
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      if (__stopRequested) return "N/A";
      const val = tryExtractPostPublishTimeOnce(publisherHandle);
      if (val !== "N/A") return val;
      await sleepInterruptible(stepMs);
    }

    return "N/A";
  }

  function extractReposts() {
    const repostSvg = document.querySelector('svg[aria-label="Repost"]');
    if (!repostSvg) return "N/A";

    const repostBtn = repostSvg.closest('[role="button"]');
    if (!repostBtn) return "N/A";

    const parent = repostBtn.parentElement;
    if (parent) {
      const kids = Array.from(parent.children);
      const idx = kids.indexOf(repostBtn);
      for (let i = idx + 1; i < kids.length; i++) {
        const k = kids[i];
        const txt = normalizeWs(k.innerText || k.textContent);
        if (!txt) continue;

        const token = txt.split(" ")[0];
        if (/^\d+(\.\d+)?[kmKM]?$/.test(token)) {
          return String(parseAbbrevNumber(token));
        }
      }
    }

    const sib = repostBtn.nextElementSibling;
    if (sib) {
      const txt = normalizeWs(sib.innerText || sib.textContent);
      if (txt) return String(parseAbbrevNumber(txt));
    }

    const section = repostSvg.closest("section") || document;
    const spans = Array.from(section.querySelectorAll('span[role="button"]'));
    for (const sp of spans) {
      if (repostBtn.compareDocumentPosition(sp) & Node.DOCUMENT_POSITION_FOLLOWING) {
        const txt = normalizeWs(sp.textContent);
        if (!txt) continue;
        const token = txt.split(" ")[0];
        if (/^\d+(\.\d+)?[kmKM]?$/.test(token)) {
          return String(parseAbbrevNumber(token));
        }
      }
    }

    return "N/A";
  }

  // -------------------------
  // ✅ OG description cleanup (caption only)
  // -------------------------

  function extractCaptionFromOgDescription(ogTextRaw) {
    const raw = (ogTextRaw ?? "").trim();
    if (!raw) return "N/A";

    // Prefer final quoted caption: ...: "CAPTION".
    let m = raw.match(/:\s*[“"]([\s\S]*?)[”"]\s*\.?\s*$/);
    if (m && m[1]) return m[1].trim();

    // Fallback: plain quotes
    const firstQ = raw.indexOf('"');
    const lastQ = raw.lastIndexOf('"');
    if (firstQ !== -1 && lastQ > firstQ) return raw.slice(firstQ + 1, lastQ).trim();

    // Fallback: curly quotes
    const firstC = raw.indexOf("“");
    const lastC = raw.lastIndexOf("”");
    if (firstC !== -1 && lastC > firstC) return raw.slice(firstC + 1, lastC).trim();

    // Last resort: after last colon
    const idx = raw.lastIndexOf(":");
    if (idx !== -1 && idx + 1 < raw.length) return raw.slice(idx + 1).trim();

    return raw;
  }

  // -------------------------
  // Comment scraping helpers
  // -------------------------

  function extractOgCounts() {
    const og = document.querySelector('meta[property="og:description"]')?.content || "";
    const text = normalizeWs(og);
    let likes = "N/A";
    let comments = "N/A";

    const likesMatch = text.match(/([\d.,]+)\s+likes?/i);
    const commentsMatch = text.match(/([\d.,]+)\s+comments?/i);

    if (likesMatch) likes = String(parseAbbrevNumber(likesMatch[1]));
    if (commentsMatch) comments = String(parseAbbrevNumber(commentsMatch[1]));

    const captionOnly = extractCaptionFromOgDescription(og);

    return { ogDescription: text || "N/A", captionOnly, likes, comments };
  }

  function extractUsername(root) {
    const anchors = profileAnchors(root);
    for (const a of anchors) {
      const handle = getAnchorHandle(a);
      if (!handle) continue;

      const visible = cleanHandleText(a.querySelector("span")?.innerText || a.innerText || a.textContent, handle);
      return visible || handle;
    }
    return "";
  }

  function extractCommentText(root, username) {
    const nodes = Array.from(root.querySelectorAll('[dir="auto"]'));

    const candidates = nodes
      .filter((sp) => {
        const txt = normalizeWs(sp.innerText || sp.textContent);
        if (!txt) return false;

        if (sp.closest("a")) return false;
        if (sp.closest('[role="button"], button')) return false;

        const low = txt.toLowerCase();
        if (low === "reply") return false;
        if (low === "see translation") return false;
        if (/^\d+(?:[.,]\d+)?[km]?\s+likes?$/i.test(txt)) return false;
        if (username && cleanHandleText(txt) === cleanHandleText(username)) return false;

        return true;
      })
      .sort((a, b) => normalizeWs(b.innerText || b.textContent).length - normalizeWs(a.innerText || a.textContent).length);

    return normalizeWs(candidates[0]?.innerText || candidates[0]?.textContent || "");
  }

  function extractCommentTime(root) {
    const t =
      root.querySelector('a[href*="/c/"] time[datetime]') ||
      root.querySelector("time[datetime]");
    if (!t) return "N/A";
    return normalizeWs(t.textContent || t.getAttribute("title") || t.getAttribute("datetime") || "N/A");
  }

  function extractCommentId(root) {
    const link = root.querySelector('a[href*="/c/"]');
    const href = link?.getAttribute("href") || "";
    const m = href.match(/\/c\/(\d+)\//);
    return m ? m[1] : "";
  }

  function extractLikeCount(root) {
    const btns = Array.from(root.querySelectorAll('[role="button"], button'));
    for (const b of btns) {
      const txt = normalizeWs(b.innerText);
      if (!txt) continue;
      if (/\blike\b/i.test(txt)) return parseAbbrevNumber(txt);
    }
    return 0;
  }

  function extractFirstUid89(text) {
    const m = String(text || "").match(/\b\d{8,9}\b/);
    return m ? m[0] : "";
  }

  function hasCommentLikeControl(el) {
    const labels = [
      ...Array.from(el.querySelectorAll('svg[aria-label]')).map((x) => x.getAttribute("aria-label")),
      ...Array.from(el.querySelectorAll("svg title")).map((x) => x.textContent),
    ]
      .map((x) => normalizeWs(x).toLowerCase())
      .filter(Boolean);

    return labels.some((x) =>
      [
        "like",
        "unlike",
        "gefällt mir",
        "gefällt mir nicht",
        "me gusta",
        "ya no me gusta",
      ].includes(x)
    );
  }

  function getCommentRootFromTime(timeEl) {
    let bestWithText = null;
    let el = timeEl;

    for (let i = 0; i < 25 && el; i++) {
      el = el.parentElement;
      if (!el) break;

      const hasProfileLink = profileAnchors(el).length > 0;
      const hasCommentTime = !!el.querySelector('a[href*="/c/"] time[datetime]');
      const hasLikeIcon = hasCommentLikeControl(el);
      const username = hasProfileLink ? extractUsername(el) : "";
      const hasText = !!(username && extractCommentText(el, username));

      if (hasCommentTime && hasProfileLink && hasText) {
        bestWithText = bestWithText || el;
        if (hasLikeIcon) return el;
      }
    }

    return bestWithText;
  }

  function findCommentRoots(mount) {
    const times = Array.from(mount.querySelectorAll('a[href*="/c/"] time[datetime]'));
    const roots = [];
    for (const t of times) {
      const root = getCommentRootFromTime(t);
      if (root) roots.push(root);
    }
    const uniq = Array.from(new Set(roots));
    return uniq.filter((r) => !uniq.some((other) => other !== r && other.contains(r)));
  }

  function commentKey(c) {
    if (c.commentId) return `id:${c.commentId}`;
    return `u:${c.username}|t:${c.time}|c:${c.text}`;
  }

  function hasHiddenCommentsBlock(mount) {
    if (mount.querySelector('svg[aria-label="View hidden comments"]')) return true;
    if (mount.querySelector('[aria-label="View hidden comments"]')) return true;
    const titles = Array.from(mount.querySelectorAll("svg title"));
    return titles.some((t) => normalizeWs(t.textContent) === "View hidden comments");
  }

  // ---- Ensure comments exist ----
  const timeNodes = Array.from(document.querySelectorAll('a[href*="/c/"] time[datetime]'));
  if (!timeNodes.length) {
    throw new Error("No comment <time datetime> nodes found. Make sure comments are visible.");
  }

  // ---- Find mount container ----
  const sample = timeNodes.slice(0, 12);
  const ancestors = (el) => {
    const arr = [];
    while (el) {
      arr.push(el);
      el = el.parentElement;
    }
    return arr;
  };

  let common = ancestors(sample[0]);
  for (let i = 1; i < sample.length; i++) {
    const set = new Set(ancestors(sample[i]));
    common = common.filter((a) => set.has(a));
  }

  const mount = common[0] || document.body;
  const scrollTarget = findScrollTarget(mount);

  // ---- Post metadata ----
  const nowStr = new Date().toString();
  const postUrl = location.href;

  const publisher = extractPublisher();
  const publishTime = await extractPostPublishTime(publisher.handle);
  const reposts = extractReposts();

  const og = extractOgCounts();

  // ---- Collect comments ----
  const seen = new Set();
  const comments = [];

  const reportedCount =
    og.comments !== "N/A" && /^\d+$/.test(String(og.comments)) ? parseInt(og.comments, 10) : NaN;

  function gapToReported() {
    if (!Number.isFinite(reportedCount)) return 0;
    return Math.max(0, reportedCount - comments.length);
  }

  function dynamicSettleMs() {
    if (!Number.isFinite(reportedCount)) return CFG.BASE_SETTLE_MS;
    const gap = gapToReported();
    const extra = Math.min(8000, Math.round(gap * 22));
    return Math.min(CFG.MAX_SETTLE_MS, CFG.BASE_SETTLE_MS + extra);
  }

  function dynamicIdleLimit() {
    if (!Number.isFinite(reportedCount)) return CFG.BASE_IDLE_ROUNDS_BEFORE_STOP;

    const gap = gapToReported();
    if (gap >= 300) return CFG.BASE_IDLE_ROUNDS_BEFORE_STOP * 6;
    if (gap >= 150) return CFG.BASE_IDLE_ROUNDS_BEFORE_STOP * 4;
    if (gap >= 75) return CFG.BASE_IDLE_ROUNDS_BEFORE_STOP * 3;
    if (gap >= 30) return CFG.BASE_IDLE_ROUNDS_BEFORE_STOP * 2;
    return CFG.BASE_IDLE_ROUNDS_BEFORE_STOP;
  }

  function scan(reason) {
    const roots = findCommentRoots(mount);
    let added = 0;

    for (const r of roots) {
      const username = extractUsername(r);
      const text = extractCommentText(r, username);
      if (!username || !text) continue;

      const c = {
        username,
        nickname: username,
        userAt: username,
        userUrl: `https://www.instagram.com/${username}/`,
        text,
        time: extractCommentTime(r),
        likes: extractLikeCount(r),
        commentId: extractCommentId(r),
      };
      c.uid = extractFirstUid89(c.text);

      const key = commentKey(c);
      if (seen.has(key)) continue;

      seen.add(key);
      comments.push(c);
      added++;
    }

    if (added > 0) {
      chrome.runtime.sendMessage({ type: "progress", runId, count: comments.length });
      console.log(
        `✅ +${added} (${reason}) Total: ${comments.length}` +
          (Number.isFinite(reportedCount) ? ` | gap: ${gapToReported()}` : "")
      );
    }
    return added;
  }

  function buildAndSendDone(reason) {
    scan("final");

    const actualCount = comments.length;
    const reported = Number.isFinite(reportedCount) ? reportedCount : NaN;
    const diff = Number.isFinite(reported) ? String(Math.max(0, reported - actualCount)) : "N/A";

    const metaPairs = [
      ["Now", nowStr],
      ["Post URL", postUrl],
      ["Publisher Nickname", publisher.nickname],
      ["Publisher @", publisher.handle],
      ["Publisher URL", publisher.url],
      ["Publish Time", publishTime],
      ["Post Likes", og.likes !== "N/A" ? og.likes : "N/A"],
      ["Reposts", reposts],
      // ✅ caption only
      ["Description", og.captionOnly !== "N/A" ? og.captionOnly : "N/A"],
      ["Number of 1st level comments", String(actualCount)],
      ["Total Comments (actual, rendered)", String(actualCount)],
      ["Total Comments (Instagram reported)", og.comments !== "N/A" ? og.comments : "N/A"],
      ["Difference", diff],
    ];

    // ✅ Removed "Profile Picture URL"
    const header = [
      "Comment Number (ID)",
      "Nickname",
      "User @",
      "User URL",
      "Comment Text",
      "Time",
      "Likes",
      "UID",
    ];

    const rows = comments.map((c, idx) => [
      String(idx + 1),
      c.nickname || "N/A",
      c.userAt || "N/A",
      c.userUrl || "N/A",
      c.text || "",
      c.time || "N/A",
      String(c.likes ?? 0),
      c.uid || "N/A",
    ]);

    chrome.runtime.sendMessage({
      type: "done",
      runId,
      reason,
      sheet: { metaPairs, header, rows },
      count: actualCount,
    });
  }

  scan("initial");

  let debounce = null;
  const observer = new MutationObserver(() => {
    clearTimeout(debounce);
    debounce = setTimeout(() => scan("mutation"), 120);
  });
  observer.observe(mount, { childList: true, subtree: true });

  let idleRounds = 0;
  let rounds = 0;
  let lastScrollTop = -1;

  let hiddenEncountered = false;
  let stuckRounds = 0;

  while (rounds < CFG.MAX_ROUNDS) {
    rounds++;

    if (__stopRequested) {
      observer.disconnect();
      buildAndSendDone("user_stop");
      return;
    }

    if (!hiddenEncountered && hasHiddenCommentsBlock(mount)) {
      hiddenEncountered = true;
      console.log("👁️ Hidden comments block detected. Will stop if scrolling becomes stuck.");
      scan("hidden-detected");
    }

    if (scrollTarget) {
      const nextTop = scrollTarget.scrollTop + CFG.SCROLL_STEP_PX;
      scrollTarget.scrollTop = Math.min(nextTop, Math.max(0, scrollTarget.scrollHeight - scrollTarget.clientHeight));
    } else {
      window.scrollBy(0, CFG.SCROLL_STEP_PX);
      window.scrollTo(0, document.documentElement.scrollHeight);
    }

    await sleepInterruptible(dynamicSettleMs());
    if (__stopRequested) {
      observer.disconnect();
      buildAndSendDone("user_stop");
      return;
    }

    let newlyFound = scan("scroll");

    if (newlyFound === 0 && Number.isFinite(reportedCount) && gapToReported() > 30) {
      await sleepInterruptible(CFG.EXTRA_RESCAN_WAIT_MS);
      if (__stopRequested) {
        observer.disconnect();
        buildAndSendDone("user_stop");
        return;
      }
      newlyFound += scan("scroll-rescan");
    }

    let curScrollTop;
    if (scrollTarget) {
      curScrollTop = scrollTarget.scrollTop;
    } else {
      const se = document.scrollingElement || document.documentElement;
      curScrollTop = se.scrollTop;
    }
    const moved = curScrollTop !== lastScrollTop;
    lastScrollTop = curScrollTop;

    if (hiddenEncountered && !moved && newlyFound === 0) {
      stuckRounds++;
      if (stuckRounds >= CFG.STUCK_ROUNDS_BEFORE_STOP) {
        observer.disconnect();
        buildAndSendDone("hidden_comments_blocked");
        return;
      }
    } else {
      stuckRounds = 0;
    }

    if (newlyFound > 0) {
      idleRounds = 0;
      continue;
    }

    idleRounds += moved ? 1 : 2;
    const idleLimit = dynamicIdleLimit();
    if (idleRounds >= idleLimit) break;
  }

  observer.disconnect();

  if (__stopRequested) {
    buildAndSendDone("user_stop");
  } else {
    buildAndSendDone("completed");
  }
}

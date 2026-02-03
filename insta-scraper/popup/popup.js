document.addEventListener("DOMContentLoaded", () => {
  const scrapeBtn = document.getElementById("scrapeBtn");
  const stopBtn = document.getElementById("stopBtn");
  const status = document.getElementById("status");

  let currentRunId = null;
  let downloadedForRun = false;

  chrome.runtime.onMessage.addListener((msg) => {
    if (currentRunId && msg?.runId && msg.runId !== currentRunId) return;

    if (msg.type === "progress") {
      const n = msg.count ?? 0;
      status.textContent = `Scraped ${n} comment${n !== 1 ? "s" : ""}`;
    }

    if (msg.type === "done") {
      if (downloadedForRun) return;
      downloadedForRun = true;

      const count = msg.count ?? 0;
      const reason = msg.reason || "completed";

      scrapeBtn.textContent = "Scraping finished";
      scrapeBtn.classList.remove("btn-secondary");
      scrapeBtn.classList.add("btn-dark");
      scrapeBtn.disabled = true;

      stopBtn.classList.add("d-none");
      stopBtn.disabled = true;
      stopBtn.textContent = "Stop scraping";

      let extra = "";
      if (reason === "user_stop") extra = "<br><b>Stopped by user</b>";
      if (reason === "hidden_comments_blocked") extra = "<br><b>Stopped: hidden comments block detected</b>";
      if (reason === "stuck_scroll") extra = "<br><b>Stopped: scrolling stuck</b>";

      status.innerHTML =
        `Scraped ${count} comment${count !== 1 ? "s" : ""}<br><b>Comments saved as spreadsheet</b>${extra}`;

      if (!msg.sheet) {
        status.textContent = "Error: No sheet data received.";
        return;
      }

      downloadXlsxExact(msg.sheet);
    }

    if (msg.type === "error") {
      scrapeBtn.disabled = false;
      scrapeBtn.textContent = "Scrape";
      scrapeBtn.classList.add("btn-secondary");
      scrapeBtn.classList.remove("btn-dark");

      stopBtn.classList.add("d-none");
      stopBtn.disabled = true;
      stopBtn.textContent = "Stop scraping";

      status.textContent = `Error: ${msg.message}`;
    }
  });

  scrapeBtn.addEventListener("click", async () => {
    downloadedForRun = false;

    scrapeBtn.disabled = true;
    scrapeBtn.textContent = "Scraping...";
    status.textContent = "Scraped 0 comments";

    stopBtn.classList.remove("d-none");
    stopBtn.disabled = false;
    stopBtn.textContent = "Stop scraping";

    currentRunId = String(Date.now()) + "_" + Math.random().toString(16).slice(2);

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    chrome.tabs.sendMessage(tab.id, { action: "scrape", runId: currentRunId });
  });

  stopBtn.addEventListener("click", async () => {
    if (!currentRunId) return;

    stopBtn.disabled = true;
    stopBtn.textContent = "Stopping...";

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    chrome.tabs.sendMessage(tab.id, { action: "stop", runId: currentRunId });
  });
});

function downloadXlsxExact({ metaPairs, header, rows }) {
  // ✅ now 8 columns (Profile Picture URL removed)
  const MAX_COLS = 8;

  const padRow = (arr) => {
    const r = Array.isArray(arr) ? arr.slice() : [];
    while (r.length < MAX_COLS) r.push("");
    return r.slice(0, MAX_COLS);
  };

  const aoa = [];

  for (const [k, v] of metaPairs) {
    aoa.push(padRow([k, v]));
  }

  aoa.push(padRow(header));

  for (const r of rows) {
    aoa.push(padRow(r));
  }

  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(aoa);
  XLSX.utils.book_append_sheet(workbook, sheet, "Comments");

  const wbout = XLSX.write(workbook, { bookType: "xlsx", type: "array" });
  const blob = new Blob([wbout], { type: "application/octet-stream" });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `Comments_${timestamp}.xlsx`;

  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

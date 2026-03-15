// ===== Test lele — exam.js =====
const examId = (window.location.pathname.split("/").filter(Boolean).pop() || "").trim();
const $ = (id) => document.getElementById(id);

let EXAM = null;
let LOCKED = false;
let TIMER_ID = null;
let TIME_OVER_AUTO = false;
let SLIDE_MODE = false;
let SLIDE_CURRENT = 1;

// Track time per question
let Q_START_TIMES = {};   // { qid: timestamp when first interacted }
let Q_TIME_SPENT = {};    // { qid: seconds spent }
let EXAM_START_TIME = null;

// -- Theme --
function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  localStorage.setItem("theme", t);
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute("data-theme") || "light";
  applyTheme(cur === "dark" ? "light" : "dark");
}

// -- Timer --
function fmtTime(sec) {
  const m = String(Math.floor(sec / 60)).padStart(2, "0");
  const s = String(sec % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function stopTimer() {
  if (TIMER_ID) { clearInterval(TIMER_ID); TIMER_ID = null; }
}

function startTimer(seconds) {
  stopTimer();
  const pill = $("timerPill");
  pill.style.display = "inline-flex";
  let left = seconds;
  pill.textContent = `⏱ ${fmtTime(left)}`;

  TIMER_ID = setInterval(async () => {
    left--;
    const pill = $("timerPill");
    if (left <= 60) pill.className = "pill danger";
    else if (left <= 120) pill.className = "pill warn";
    if (left <= 0) {
      stopTimer();
      pill.textContent = "⏱ 00:00";
      TIME_OVER_AUTO = true;
      setLocked(true);
      $("timeOverModal").style.display = "grid";
      await submitExam(true);
      return;
    }
    pill.textContent = `⏱ ${fmtTime(left)}`;
  }, 1000);
}

// -- Lock --
function setLocked(on) {
  LOCKED = on;
  document.querySelectorAll("input, textarea").forEach(el => {
    if (!["themeBtn","printBtn","timeOverOk","submitBtn"].includes(el.id)) {
      el.disabled = on;
    }
  });
  document.querySelectorAll(".q-card").forEach(card => {
    if (on) card.classList.add("locked");
    else card.classList.remove("locked");
  });
  if (on) {
    const btn = $("submitBtn");
    if (btn) { btn.disabled = true; btn.textContent = "Submitted ✓"; }
  }
}

// -- Progress --
function updateProgress() {
  if (!EXAM) return;
  let answered = 0;
  EXAM.questions.forEach((q, i) => {
    const idx = i + 1;
    const card = document.querySelector(`.q-card[data-qid="${idx}"]`);
    let isAnswered = false;
    if (q.type === "mcq") {
      const picked = document.querySelector(`input[name="q_${idx}"]:checked`);
      if (picked) isAnswered = true;
    } else {
      const ta = document.querySelector(`textarea[name="q_${idx}"]`);
      const photos = window._photos && window._photos[idx];
      if ((ta && ta.value.trim()) || (photos && photos.length > 0)) isAnswered = true;
    }
    if (isAnswered) {
      answered++;
      card && card.classList.add("answered");
    } else {
      card && card.classList.remove("answered");
    }
  });
  $("progressPill").textContent = `${answered} / ${EXAM.questions.length} answered`;
}

// -- Track time per question --
function recordQuestionFocus(qid) {
  if (LOCKED) return;
  Q_START_TIMES[qid] = Q_START_TIMES[qid] || Date.now();
}

function recordQuestionBlur(qid) {
  if (!Q_START_TIMES[qid]) return;
  const spent = Math.round((Date.now() - Q_START_TIMES[qid]) / 1000);
  Q_TIME_SPENT[qid] = (Q_TIME_SPENT[qid] || 0) + spent;
  Q_START_TIMES[qid] = null;
}

function finalizeAllTimes() {
  // flush any still-focused questions
  Object.keys(Q_START_TIMES).forEach(qid => {
    if (Q_START_TIMES[qid]) recordQuestionBlur(qid);
  });
}

function fmtSpent(sec) {
  if (!sec || sec < 1) return "< 1s";
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec/60)}m ${sec%60}s`;
}

// -- Collect answers --
function collectAnswers() {
  const answers = {};
  EXAM.questions.forEach((q, i) => {
    const idx = String(i + 1);
    if (q.type === "mcq") {
      const picked = document.querySelector(`input[name="q_${idx}"]:checked`);
      answers[idx] = picked ? picked.value : "";
    } else {
      const ta = document.querySelector(`textarea[name="q_${idx}"]`);
      answers[idx] = ta ? ta.value : "";
    }
  });
  return answers;
}
// -- Slide Mode --
function initSlideMode() {
  const paper = $("paper");
  const btn = $("slideModeBtn");
  if (!paper || !btn) return;

  // Insert progress bar and nav into DOM
  const progressBar = document.createElement("div");
  progressBar.className = "slide-progress-bar";
  progressBar.id = "slideProgressBar";
  progressBar.innerHTML = `<div class="slide-progress-fill" id="slideProgressFill"></div>`;
  paper.parentNode.insertBefore(progressBar, paper);

  const nav = document.createElement("div");
  nav.className = "slide-nav";
  nav.id = "slideNav";
  nav.innerHTML = `
    <button class="slide-btn" id="slidePrev">← Prev</button>
    <span class="slide-counter" id="slideCounter">1 / 1</span>
    <button class="slide-btn" id="slideNext">Next →</button>
  `;
  paper.parentNode.insertBefore(nav, paper.nextSibling);

  $("slidePrev").addEventListener("click", () => goSlide(SLIDE_CURRENT - 1));
  $("slideNext").addEventListener("click", () => goSlide(SLIDE_CURRENT + 1));

  btn.addEventListener("click", () => {
    SLIDE_MODE = !SLIDE_MODE;
    if (SLIDE_MODE) {
      paper.classList.add("slide-mode");
      btn.classList.add("slide-mode-active-btn");
      btn.textContent = "☰ Scroll";
      goSlide(1);
    } else {
      paper.classList.remove("slide-mode");
      btn.classList.remove("slide-mode-active-btn");
      btn.textContent = "▦ Slide";
      // Show all cards again
      document.querySelectorAll(".q-card").forEach(c => {
        c.classList.remove("slide-active");
      });
    }
  });
}

function goSlide(n) {
  if (!EXAM) return;
  const total = EXAM.questions.length;
  SLIDE_CURRENT = Math.max(1, Math.min(n, total));

  // Track time
  trackQuestionFocus(String(SLIDE_CURRENT));

  // Show only current card
  document.querySelectorAll(".q-card").forEach((card, i) => {
    card.classList.toggle("slide-active", i + 1 === SLIDE_CURRENT);
  });

  // Update counter
  const counter = $("slideCounter");
  if (counter) counter.textContent = `${SLIDE_CURRENT} / ${total}`;

  // Update progress bar
  const fill = $("slideProgressFill");
  if (fill) fill.style.width = `${(SLIDE_CURRENT / total) * 100}%`;

  // Update prev/next buttons
  const prev = $("slidePrev");
  const next = $("slideNext");
  if (prev) prev.disabled = SLIDE_CURRENT === 1;
  if (next) {
    if (SLIDE_CURRENT === total) {
      next.innerHTML = "Submit ✓";
      next.style.background = "var(--accent)";
      next.style.color = "var(--accent-fg)";
      next.style.borderColor = "var(--accent)";
      next.onclick = () => {
        if (!LOCKED) submitExam(false);
      };
    } else {
      next.innerHTML = "Next →";
      next.style.background = "";
      next.style.color = "";
      next.style.borderColor = "";
      next.onclick = () => goSlide(SLIDE_CURRENT + 1);
    }
  }
}

// -- Render --
function renderExam(exam) {
  EXAM = exam;
  window._photos = {};
  EXAM_START_TIME = Date.now();

  $("paperTitle").textContent = exam.title || "Test Paper";
  const meta = exam.meta || {};
  $("paperMeta").textContent = [
    meta.mode || "practice",
    meta.difficulty || "",
    meta.qtype || ""
  ].filter(Boolean).join(" · ");
  $("paperInfo").textContent = meta.mode === "exam"
    ? "Exam Mode — answers shown after submission."
    : "Practice Mode — reveal answers anytime.";

  const wrap = $("paper");
  wrap.innerHTML = "";

  exam.questions.forEach((q, i) => {
    const idx = i + 1;
    const qid = String(idx);

    const diffMatch = q.q.match(/\[(EASY|MEDIUM|HARD)\]/i);
    const diff = diffMatch ? diffMatch[1].toLowerCase() : "medium";
    const cleanQ = q.q.replace(/\[(EASY|MEDIUM|HARD)\]\s*/i, "").trim();

    const card = document.createElement("div");
    card.className = "q-card";
    card.dataset.qid = qid;

    // Track time when card is clicked/focused
    card.addEventListener("mouseenter", () => recordQuestionFocus(qid));
    card.addEventListener("mouseleave", () => recordQuestionBlur(qid));
    card.addEventListener("focusin",    () => recordQuestionFocus(qid));
    card.addEventListener("focusout",   () => recordQuestionBlur(qid));

    card.innerHTML = `
      <div class="q-head">
        <div class="q-meta">
          <span class="q-num">Q${idx} · ${q.type.toUpperCase()}</span>
          <span class="q-diff ${diff}">${diff.charAt(0).toUpperCase() + diff.slice(1)}</span>
        </div>
        <span class="q-marks">${q.type === "mcq" ? "1 mark" : `${q.marks || 3} marks`}</span>
      </div>
      <div class="q-text">${cleanQ}</div>
    `;

    if (q.type === "mcq") {
      (q.options || []).forEach(opt => {
        const label = document.createElement("label");
        label.className = "opt";
        label.innerHTML = `
          <input type="radio" name="q_${qid}" value="${opt.key}">
          <span><b>${opt.key}.</b> ${opt.text}</span>
        `;
        label.querySelector("input").addEventListener("change", updateProgress);
        card.appendChild(label);
      });

      if (meta.mode === "practice" && meta.include_answers) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "reveal-btn";
        btn.innerHTML = "👁 Reveal Answer";
        btn.addEventListener("click", () => {
          const box = document.createElement("div");
          box.className = "key-box";
          box.innerHTML = `<b>Answer:</b> ${q.answer}<br/><b>Explanation:</b> ${q.explain || "—"}`;
          btn.replaceWith(box);
        });
        card.appendChild(btn);
      }

    } else {
      const tabs = document.createElement("div");
      tabs.className = "answer-tabs";
      tabs.innerHTML = `
        <button type="button" class="answer-tab active" data-tab="type">✏️ Type</button>
        <button type="button" class="answer-tab" data-tab="photo">📷 Upload Photo</button>
      `;
      card.appendChild(tabs);

      const typePanel = document.createElement("div");
      typePanel.dataset.panel = "type";
      const ta = document.createElement("textarea");
      ta.className = "answer-box";
      ta.name = `q_${qid}`;
      ta.placeholder = "Write your answer here…";
      ta.addEventListener("input", updateProgress);
      typePanel.appendChild(ta);
      card.appendChild(typePanel);

      const photoPanel = document.createElement("div");
      photoPanel.dataset.panel = "photo";
      photoPanel.style.display = "none";
      photoPanel.innerHTML = `
        <div class="photo-area" id="photoArea_${qid}">
          <label class="photo-label" for="photoInput_${qid}">
            <span class="ico">📷</span>
            <span>Click to upload your handwritten answer</span>
            <span style="font-size:.75rem;margin-top:2px;">JPG, PNG supported</span>
          </label>
          <input type="file" id="photoInput_${qid}" accept="image/*" multiple>
          <div class="photo-preview" id="photoPreview_${qid}"></div>
        </div>
      `;
      card.appendChild(photoPanel);

      tabs.querySelectorAll(".answer-tab").forEach(tab => {
        tab.addEventListener("click", () => {
          tabs.querySelectorAll(".answer-tab").forEach(t => t.classList.remove("active"));
          tab.classList.add("active");
          const target = tab.dataset.tab;
          typePanel.style.display = target === "type" ? "" : "none";
          photoPanel.style.display = target === "photo" ? "" : "none";
        });
      });

      photoPanel.querySelector(`#photoInput_${qid}`).addEventListener("change", (e) => {
        const files = Array.from(e.target.files);
        if (!window._photos[qid]) window._photos[qid] = [];
        files.forEach(file => {
          const reader = new FileReader();
          reader.onload = (ev) => {
            window._photos[qid].push(ev.target.result);
            renderPhotoPreview(qid);
            updateProgress();
          };
          reader.readAsDataURL(file);
        });
        e.target.value = "";
      });

      if (meta.mode === "practice" && meta.include_answers) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "reveal-btn";
        btn.innerHTML = "👁 Reveal Model Answer";
        btn.addEventListener("click", () => {
          const kp = (q.key_points || []).map(x => `<li>${x}</li>`).join("");
          const box = document.createElement("div");
          box.className = "key-box";
          box.innerHTML = `<b>Model:</b> ${q.model || "—"}<br/><b>Key Points:</b><ul>${kp}</ul>`;
          btn.replaceWith(box);
        });
        card.appendChild(btn);
      }
    }

    wrap.appendChild(card);
  });

  const tmin = Number(meta.timer_minutes || 0);
  if (tmin > 0) startTimer(tmin * 60);

  document.addEventListener("change", updateProgress);
  updateProgress();
  // Init slide mode after questions are rendered
  initSlideMode();
}

function renderPhotoPreview(qid) {
  const preview = document.getElementById(`photoPreview_${qid}`);
  if (!preview) return;
  const photos = window._photos[qid] || [];
  preview.innerHTML = photos.map((src, i) => `
    <div class="photo-thumb">
      <img src="${src}" alt="Answer photo ${i+1}">
      <button class="rm-photo" data-qid="${qid}" data-idx="${i}" title="Remove">✕</button>
    </div>
  `).join("");
  preview.querySelectorAll(".rm-photo").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const q = btn.dataset.qid;
      const idx = Number(btn.dataset.idx);
      window._photos[q].splice(idx, 1);
      renderPhotoPreview(q);
      updateProgress();
    });
  });
}

// -- Submit --
async function submitExam(time_over = false) {
  if (!EXAM) return;
  if (LOCKED && !time_over) return;

  finalizeAllTimes(); // ⭐ lock in all question times
  stopTimer();
  setLocked(true);

  const status = $("submitStatus");
  status.textContent = "Submitting…";
  status.className = "sub-status";

  try {
    const r = await fetch(`/api/submit/${examId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers: collectAnswers(), time_over })
    });
    const data = await r.json();
    if (!data.ok) {
      status.textContent = "Submit failed. Try again.";
      status.className = "sub-status err";
      return;
    }
    status.textContent = "Submitted ✓";
    status.className = "sub-status ok";
    showResult(data.result);
  } catch (err) {
    status.textContent = "Network error.";
    status.className = "sub-status err";
  }
}

// -- Share --
function buildShareText(res) {
  const topic = EXAM?.title || "a topic";
  const pct = res.percentage;
  const grade = res.grade;
  return `I just scored ${pct}% (${grade}) on a "${topic}" practice test on Test lele! 🎯\nTry it free → https://test-lele-production.up.railway.app`;
}

function showShareButtons(res) {
  const text = encodeURIComponent(buildShareText(res));
  const wa  = `https://wa.me/?text=${text}`;
  const tw  = `https://twitter.com/intent/tweet?text=${text}`;

  const div = document.createElement("div");
  div.className = "share-row";
  div.innerHTML = `
    <div class="share-label">📤 Share your result</div>
    <div class="share-btns">
      <a class="share-btn whatsapp" href="${wa}" target="_blank" rel="noopener">
        <span>💬</span> WhatsApp
      </a>
      <a class="share-btn twitter" href="${tw}" target="_blank" rel="noopener">
        <span>🐦</span> Twitter/X
      </a>
      <button class="share-btn copy" id="copyShareBtn">
        <span>📋</span> Copy Link
      </button>
    </div>
  `;
  return div;
}

// -- Time per question table --
function buildTimeTable() {
  if (!EXAM) return null;
  const totalSec = Math.round((Date.now() - EXAM_START_TIME) / 1000);

  const rows = EXAM.questions.map((q, i) => {
    const qid = String(i + 1);
    const sec = Q_TIME_SPENT[qid] || 0;
    const pct = totalSec > 0 ? Math.round((sec / totalSec) * 100) : 0;
    const bar = `<div class="time-bar-wrap"><div class="time-bar" style="width:${Math.min(pct,100)}%"></div></div>`;
    return `
      <tr>
        <td class="tc-q">Q${qid}</td>
        <td class="tc-type">${q.type.toUpperCase()}</td>
        <td class="tc-time">${fmtSpent(sec)}</td>
        <td class="tc-bar">${bar}</td>
      </tr>
    `;
  }).join("");

  const div = document.createElement("div");
  div.className = "time-table-wrap";
  div.innerHTML = `
    <div class="result-section">
      <h3>⏱ Time Spent per Question</h3>
      <p style="font-size:.8rem;color:var(--muted);margin-bottom:10px;">
        Total exam time: <b>${fmtSpent(totalSec)}</b>
      </p>
      <table class="time-table">
        <thead>
          <tr>
            <th>Q#</th><th>Type</th><th>Time</th><th>Proportion</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
  return div;
}

function showResult(res) {
  const box = $("result");
  box.style.display = "block";
  box.className = "result-card";

  const miss = (res.missing_points || []).map(x => `<li>${x}</li>`).join("");
  const rev  = (res.suggested_revision || []).map(x => `<li>${x}</li>`).join("");

  box.innerHTML = `
    <div class="result-score">${res.percentage}%</div>
    <div class="result-grade">${res.grade} · ${res.score}</div>
    <div class="result-feedback">${res.feedback}</div>
    <hr/>
    <div class="result-section">
      <h3>Missing Points</h3>
      <ul>${miss || "<li>None — great job!</li>"}</ul>
    </div>
    <div class="result-section">
      <h3>Suggested Revision</h3>
      <ul>${rev || "<li>—</li>"}</ul>
    </div>
  `;

  // ⭐ Time per question table
  const timeTable = buildTimeTable();
  if (timeTable) box.appendChild(timeTable);

  // ⭐ Share buttons
  const shareDiv = showShareButtons(res);
  box.appendChild(shareDiv);

  // Copy link button
  box.querySelector("#copyShareBtn")?.addEventListener("click", () => {
    const txt = buildShareText(res);
    navigator.clipboard.writeText(txt).then(() => {
      const btn = box.querySelector("#copyShareBtn");
      btn.innerHTML = "<span>✅</span> Copied!";
      setTimeout(() => btn.innerHTML = "<span>📋</span> Copy Link", 2000);
    });
  });

  // Show answer keys
  if (res.answer_key) {
    Object.keys(res.answer_key).forEach(qid => {
      const key = res.answer_key[qid];
      const card = document.querySelector(`.q-card[data-qid="${qid}"]`);
      if (!card) return;
      const div = document.createElement("div");
      div.className = "key-box";
      div.style.marginTop = "12px";
      if (key.type === "mcq") {
        div.innerHTML = `<b>Answer:</b> ${key.answer}<br/><b>Explanation:</b> ${key.explain || "—"}`;
      } else {
        const kp = (key.key_points || []).map(x => `<li>${x}</li>`).join("");
        div.innerHTML = `<b>Model:</b> ${key.model || "—"}<br/><b>Key Points:</b><ul>${kp}</ul>`;
      }
      card.appendChild(div);
    });
  }

  box.scrollIntoView({ behavior: "smooth", block: "start" });

  // Waitlist popup after 4s
  setTimeout(() => {
    const modal = document.getElementById("wlModal");
    if (modal && !sessionStorage.getItem("wl_shown")) {
      modal.style.display = "grid";
      sessionStorage.setItem("wl_shown", "1");
    }
  }, 4000);
}

async function loadExam() {
  try {
    const r = await fetch(`/api/exam/${examId}`);
    const data = await r.json();
    if (data.error) { $("submitStatus").textContent = data.error; return; }
    renderExam(data);
  } catch {
    $("submitStatus").textContent = "Failed to load exam.";
  }
}

// -- Init --
document.addEventListener("DOMContentLoaded", async () => {
  applyTheme(localStorage.getItem("theme") || "light");
  $("themeBtn")?.addEventListener("click", toggleTheme);
  $("printBtn")?.addEventListener("click", () => window.print());
  $("timeOverOk")?.addEventListener("click", () => {
    $("timeOverModal").style.display = "none";
  });
  $("submitBtn")?.addEventListener("click", async () => {
    if (TIME_OVER_AUTO || LOCKED) return;
    stopTimer();
    await submitExam(false);
  });
  if (!examId) {
    $("submitStatus").textContent = "Error: missing exam ID in URL.";
    return;
  }
  await loadExam();
});
// ===== Test lele — exam.js =====
const examId = (window.location.pathname.split("/").filter(Boolean).pop() || "").trim();
const $ = (id) => document.getElementById(id);

let EXAM = null;
let LOCKED = false;
let TIMER_ID = null;
let TIME_OVER_AUTO = false;
let SLIDE_MODE = false;
let SLIDE_CURRENT = 1;

// Per-question timer
let Q_TIME_LEFT = {};
let Q_TIMER_IDS = {};
let Q_SUBMITTED = {};

// Track time per question
let Q_START_TIMES = {};
let Q_TIME_SPENT = {};
let EXAM_START_TIME = null;

let PER_Q_SECONDS = 0;

// -- Theme --
function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  localStorage.setItem("theme", t);
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute("data-theme") || "light";
  applyTheme(cur === "dark" ? "light" : "dark");
}

// -- Timer (global) --
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

// -- Per-question timer --
function startQuestionTimer(qid, seconds) {
  if (Q_TIMER_IDS[qid]) {
    clearInterval(Q_TIMER_IDS[qid]);
    Q_TIMER_IDS[qid] = null;
  }
  Q_TIME_LEFT[qid] = seconds;

  const pill = document.querySelector(`.q-timer-pill[data-qid="${qid}"]`);
  if (pill) pill.textContent = `⏱ ${fmtTime(seconds)}`;

  Q_TIMER_IDS[qid] = setInterval(() => {
    Q_TIME_LEFT[qid]--;
    const left = Q_TIME_LEFT[qid];
    if (pill) {
      pill.textContent = `⏱ ${fmtTime(left)}`;
      if (left <= 10) pill.style.color = "var(--danger, #e53)";
    }
    if (left <= 0) {
      clearInterval(Q_TIMER_IDS[qid]);
      Q_TIMER_IDS[qid] = null;
      lockQuestion(qid);
      moveToNextQuestion(qid);
    }
  }, 1000);
}

function stopQuestionTimer(qid) {
  if (Q_TIMER_IDS[qid]) {
    clearInterval(Q_TIMER_IDS[qid]);
    Q_TIMER_IDS[qid] = null;
  }
}

function lockQuestion(qid) {
  Q_SUBMITTED[qid] = true;
  const card = document.querySelector(`.q-card[data-qid="${qid}"]`);
  if (!card) return;

  card.querySelectorAll("input, textarea").forEach(el => el.disabled = true);
  card.classList.add("locked");

  const submitBtn = card.querySelector(".q-submit-btn");
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = "Submitted ✓";
    submitBtn.style.background = "var(--success, #2a7)";
  }

  stopQuestionTimer(qid);

  const meta = EXAM?.meta || {};
  if (meta.mode === "practice" && meta.include_answers) {
    const q = EXAM.questions[parseInt(qid) - 1];
    if (q && q.type === "mcq") {
      const existing = card.querySelector(".key-box");
      if (!existing) {
        const box = document.createElement("div");
        box.className = "key-box";
        box.style.marginTop = "10px";
        const correctOpt = (q.options || []).find(o => o.key === q.answer);
        box.innerHTML = `<b>Answer:</b> ${q.answer}${correctOpt ? " — " + correctOpt.text : ""}<br/><b>Explanation:</b> ${q.explain || "—"}`;
        card.appendChild(box);
      }
    }
  }
}

function moveToNextQuestion(qid) {
  if (!EXAM) return;
  const current = parseInt(qid);
  const total = EXAM.questions.length;

  if (current < total) {
    const nextQid = String(current + 1);
    const nextCard = document.querySelector(`.q-card[data-qid="${nextQid}"]`);
    if (nextCard) {
      nextCard.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    if (PER_Q_SECONDS > 0 && !Q_SUBMITTED[nextQid]) {
      startQuestionTimer(nextQid, PER_Q_SECONDS);
    }
    if (SLIDE_MODE) goSlide(current + 1);
  } else {
    const submitBtn = $("submitBtn");
    if (submitBtn) {
      submitBtn.style.animation = "pulse 1s infinite";
      submitBtn.scrollIntoView({ behavior: "smooth" });
    }
  }
}

// -- Lock all --
function setLocked(on) {
  LOCKED = on;
  document.querySelectorAll("input, textarea").forEach(el => {
    if (!["themeBtn", "printBtn", "timeOverOk", "submitBtn"].includes(el.id)) {
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

function trackQuestionFocus(qid) {
  recordQuestionFocus(qid);
}

function finalizeAllTimes() {
  Object.keys(Q_START_TIMES).forEach(qid => {
    if (Q_START_TIMES[qid]) recordQuestionBlur(qid);
  });
}

function fmtSpent(sec) {
  if (!sec || sec < 1) return "< 1s";
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
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
  trackQuestionFocus(String(SLIDE_CURRENT));

  document.querySelectorAll(".q-card").forEach((card, i) => {
    card.classList.toggle("slide-active", i + 1 === SLIDE_CURRENT);
  });

  const counter = $("slideCounter");
  if (counter) counter.textContent = `${SLIDE_CURRENT} / ${total}`;

  const fill = $("slideProgressFill");
  if (fill) fill.style.width = `${(SLIDE_CURRENT / total) * 100}%`;

  const prev = $("slidePrev");
  const next = $("slideNext");
  if (prev) prev.disabled = SLIDE_CURRENT === 1;
  if (next) {
    if (SLIDE_CURRENT === total) {
      next.innerHTML = "Submit ✓";
      next.style.background = "var(--accent)";
      next.style.color = "var(--accent-fg)";
      next.style.borderColor = "var(--accent)";
      next.onclick = () => { if (!LOCKED) submitExam(false); };
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
    meta.exam_format || "",
    meta.mode || "practice",
    meta.difficulty || "",
  ].filter(Boolean).join(" · ");
  $("paperInfo").textContent = meta.mode === "exam"
    ? "Exam Mode — answers shown after submission."
    : "Practice Mode — reveal answers anytime.";

  const totalMinutes = Number(meta.timer_minutes || 0);
  if (totalMinutes > 0 && exam.questions.length > 0) {
    PER_Q_SECONDS = Math.floor((totalMinutes * 60) / exam.questions.length);
  }

  const wrap = $("paper");
  wrap.innerHTML = "";

  exam.questions.forEach((q, i) => {
    const idx = i + 1;
    const qid = String(idx);

    // Clean question text
    const cleanQ = q.q.replace(/\[(EASY|MEDIUM|HARD)\]\s*/i, "").trim();

    const card = document.createElement("div");
    card.className = "q-card";
    card.dataset.qid = qid;

    card.addEventListener("mouseenter", () => recordQuestionFocus(qid));
    card.addEventListener("mouseleave", () => recordQuestionBlur(qid));
    card.addEventListener("focusin", () => recordQuestionFocus(qid));
    card.addEventListener("focusout", () => recordQuestionBlur(qid));

    const timerPillHtml = PER_Q_SECONDS > 0
      ? `<span class="q-timer-pill" data-qid="${qid}">⏱ ${fmtTime(PER_Q_SECONDS)}</span>`
      : "";

    card.innerHTML = `
      <div class="q-head">
        <div class="q-meta">
          <span class="q-num">Q${idx} · MCQ</span>
          ${timerPillHtml}
        </div>
        <span class="q-marks">1 mark</span>
      </div>
      <div class="q-text">${cleanQ}</div>
    `;

    // --- OPTIONS RENDERING (the key fix) ---
    const options = q.options;

    if (!options || options.length === 0) {
      // Fallback: show error state for this question
      const err = document.createElement("div");
      err.style.cssText = "color:var(--muted);font-size:.85rem;padding:10px 0;";
      err.textContent = "⚠️ Options failed to load for this question.";
      card.appendChild(err);
    } else {
      options.forEach(opt => {
        if (!opt || !opt.text || !String(opt.text).trim()) return;

        const label = document.createElement("label");
        label.className = "opt";

        const input = document.createElement("input");
        input.type = "radio";
        input.name = `q_${qid}`;
        input.value = opt.key;

        const span = document.createElement("span");
        span.innerHTML = `<b>${opt.key}.</b> ${opt.text}`;

        input.addEventListener("change", updateProgress);
        label.appendChild(input);
        label.appendChild(span);
        card.appendChild(label);
      });
    }

    // Per-question Submit button
    const qSubmitBtn = document.createElement("button");
    qSubmitBtn.type = "button";
    qSubmitBtn.className = "q-submit-btn";
    qSubmitBtn.dataset.qid = qid;
    qSubmitBtn.textContent = idx < exam.questions.length ? "Submit & Next →" : "Submit Answer ✓";
    qSubmitBtn.addEventListener("click", () => {
      if (Q_SUBMITTED[qid]) return;
      lockQuestion(qid);
      moveToNextQuestion(qid);
    });
    card.appendChild(qSubmitBtn);

    if (meta.mode === "practice" && meta.include_answers && PER_Q_SECONDS === 0) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "reveal-btn";
      btn.innerHTML = "👁 Reveal Answer";
      btn.addEventListener("click", () => {
        const correctOpt = (options || []).find(o => o.key === q.answer);
        const box = document.createElement("div");
        box.className = "key-box";
        box.innerHTML = `<b>Answer:</b> ${q.answer}${correctOpt ? " — " + correctOpt.text : ""}<br/><b>Explanation:</b> ${q.explain || "—"}`;
        btn.replaceWith(box);
      });
      card.appendChild(btn);
    }

    wrap.appendChild(card);
  });

  if (totalMinutes > 0) startTimer(totalMinutes * 60);
  if (PER_Q_SECONDS > 0) startQuestionTimer("1", PER_Q_SECONDS);

  document.addEventListener("change", updateProgress);
  updateProgress();
  initSlideMode();
}

function renderPhotoPreview(qid) {
  const preview = document.getElementById(`photoPreview_${qid}`);
  if (!preview) return;
  const photos = window._photos[qid] || [];
  preview.innerHTML = photos.map((src, i) => `
    <div class="photo-thumb">
      <img src="${src}" alt="Answer photo ${i + 1}">
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

// -- Submit all --
async function submitExam(time_over = false) {
  if (!EXAM) return;
  if (LOCKED && !time_over) return;

  Object.keys(Q_TIMER_IDS).forEach(qid => stopQuestionTimer(qid));
  finalizeAllTimes();
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
  const wa = `https://wa.me/?text=${text}`;
  const tw = `https://twitter.com/intent/tweet?text=${text}`;

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
    const bar = `<div class="time-bar-wrap"><div class="time-bar" style="width:${Math.min(pct, 100)}%"></div></div>`;
    return `
      <tr>
        <td class="tc-q">Q${qid}</td>
        <td class="tc-type">MCQ</td>
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
          <tr><th>Q#</th><th>Type</th><th>Time</th><th>Proportion</th></tr>
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
  const rev = (res.suggested_revision || []).map(x => `<li>${x}</li>`).join("");

  box.innerHTML = `
    <div class="result-score">${res.percentage}%</div>
    <div class="result-grade">${res.grade} · ${res.score}</div>
    <div class="result-feedback">${res.feedback}</div>
    <hr/>
    <div class="result-section">
      <h3>Missed Questions</h3>
      <ul>${miss || "<li>None — perfect score! 🎉</li>"}</ul>
    </div>
    <div class="result-section">
      <h3>Suggested Revision</h3>
      <ul>${rev || "<li>—</li>"}</ul>
    </div>
  `;

  const timeTable = buildTimeTable();
  if (timeTable) box.appendChild(timeTable);

  const shareDiv = showShareButtons(res);
  box.appendChild(shareDiv);

  box.querySelector("#copyShareBtn")?.addEventListener("click", () => {
    const txt = buildShareText(res);
    navigator.clipboard.writeText(txt).then(() => {
      const btn = box.querySelector("#copyShareBtn");
      btn.innerHTML = "<span>✅</span> Copied!";
      setTimeout(() => btn.innerHTML = "<span>📋</span> Copy Link", 2000);
    });
  });

  if (res.answer_key) {
    Object.keys(res.answer_key).forEach(qid => {
      const key = res.answer_key[qid];
      const card = document.querySelector(`.q-card[data-qid="${qid}"]`);
      if (!card) return;
      const existing = card.querySelector(".key-box");
      if (existing) return;
      const div = document.createElement("div");
      div.className = "key-box";
      div.style.marginTop = "12px";
      if (key.type === "mcq") {
        div.innerHTML = `<b>Answer:</b> ${key.answer}<br/><b>Explanation:</b> ${key.explain || "—"}`;
      }
      card.appendChild(div);
    });
  }

  box.scrollIntoView({ behavior: "smooth", block: "start" });

  setTimeout(() => {
    const modal = document.getElementById("wlModal");
    if (modal && !sessionStorage.getItem("wl_shown")) {
      modal.style.display = "grid";
      sessionStorage.setItem("wl_shown", "1");
    }
  }, 4000);
}

// -- Load exam --
async function loadExam() {
  const status = $("submitStatus");

  try {
    const r = await fetch(`/api/exam/${examId}`);
    const data = await r.json();

    if (data.error) {
      status.textContent = "❌ " + data.error;
      return;
    }

    if (!data.questions || data.questions.length === 0) {
      status.textContent = "❌ No questions found. Go back and try again.";
      $("paperTitle").textContent = "Error";
      return;
    }

    // Validate options exist on at least first question
    const firstQ = data.questions[0];
    if (!firstQ.options || firstQ.options.length === 0) {
      status.textContent = "❌ Questions loaded but options are missing. Please regenerate.";
      return;
    }

    renderExam(data);

  } catch (e) {
    if (status) status.textContent = "❌ Failed to load exam. Please go back and try again.";
    console.error("loadExam error:", e);
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
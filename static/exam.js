// ===== Test lele — exam.js (NTA-style) =====
const examId = (window.location.pathname.split("/").filter(Boolean).pop() || "").trim();
const $ = (id) => document.getElementById(id);

let EXAM = null;
let LOCKED = false;
let TIMER_ID = null;
let TIME_OVER_AUTO = false;
let CURRENT_Q = 1;  // 1-indexed

// State per question
let ANSWERS  = {};   // { "1": "A", "2": "B", ... } for MCQ; text for written
let MARKED   = {};   // { "1": true, ... }
let Q_START_TIMES = {};
let Q_TIME_SPENT  = {};
let EXAM_START_TIME = null;

// ── Theme ──
function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  localStorage.setItem("theme", t);
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute("data-theme") || "light";
  applyTheme(cur === "dark" ? "light" : "dark");
}

// ── Timer (global) ──
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
    if (left <= 60)       { pill.className = "nta-timer-pill danger"; }
    else if (left <= 120) { pill.className = "nta-timer-pill warn"; }
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

// ── Lock ──
function setLocked(on) {
  LOCKED = on;
  if (on) {
    $("bottomBar").style.display = "none";
    $("submitTopBtn").disabled = true;
    $("submitTopBtn").textContent = "Submitted ✓";
  }
}

// ── Progress bar + palette sync ──
function updateProgress() {
  if (!EXAM) return;
  const total = EXAM.questions.length;
  const answered = Object.keys(ANSWERS).filter(k => {
    const v = ANSWERS[k];
    return v && String(v).trim() !== "";
  }).length;

  // top progress bar
  $("examProgressFill").style.width = `${(answered / total) * 100}%`;

  // palette dots
  EXAM.questions.forEach((q, i) => {
    const qid = String(i + 1);
    const dot = $(`pdot-${qid}`);
    if (!dot) return;
    dot.className = "nta-p-dot";
    if (String(i + 1) === String(CURRENT_Q)) dot.classList.add("current");
    if (MARKED[qid]) dot.classList.add("marked");
    else if (ANSWERS[qid] && String(ANSWERS[qid]).trim()) dot.classList.add("answered");
  });
}

// ── Track time per Q ──
function recordQFocus(qid) {
  Q_START_TIMES[qid] = Q_START_TIMES[qid] || Date.now();
}
function recordQBlur(qid) {
  if (!Q_START_TIMES[qid]) return;
  const spent = Math.round((Date.now() - Q_START_TIMES[qid]) / 1000);
  Q_TIME_SPENT[qid] = (Q_TIME_SPENT[qid] || 0) + spent;
  Q_START_TIMES[qid] = null;
}
function finalizeAllTimes() {
  Object.keys(Q_START_TIMES).forEach(qid => {
    if (Q_START_TIMES[qid]) recordQBlur(qid);
  });
}
function fmtSpent(sec) {
  if (!sec || sec < 1) return "< 1s";
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

// ── Render one question ──
function renderQuestion(idx) {
  if (!EXAM) return;
  const total = EXAM.questions.length;
  const q = EXAM.questions[idx - 1];
  if (!q) return;

  const qid = String(idx);
  recordQBlur(String(CURRENT_Q)); // stop timing old Q
  CURRENT_Q = idx;
  recordQFocus(qid);

  // Q counter
  const container = $("activeQuestion");
 const cleanQ = q.q.replace(/\[(EASY|MEDIUM|HARD)\]\s*/i, "").trim().replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const isAnswered = ANSWERS[qid] && String(ANSWERS[qid]).trim();
  const isMarked   = MARKED[qid];

  let optionsHtml = "";
  if (q.type === "mcq" || !q.type) {
    const options = q.options || [];
    console.log("Q options:", JSON.stringify(options));
    optionsHtml = `<div class="nta-options" id="ntaOptions">` +
      options.map(opt => {
        const selected = ANSWERS[qid] === opt.key ? "selected" : "";
        return `
          <div class="nta-opt ${selected}" data-key="${opt.key}">
            <div class="nta-opt-key">${opt.key}</div>
           <div class="nta-opt-text">${String(opt.text||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
          </div>`;
      }).join("") +
    `</div>`;
  } else {
    // written
    const saved = ANSWERS[qid] || "";
    optionsHtml = `<textarea class="nta-written-box" id="writtenBox" placeholder="Type your answer here…">${saved}</textarea>`;
  }

  container.innerHTML = `
    <div class="nta-q-header">
      <div class="nta-q-counter">${idx} <span>/ ${total}</span></div>
      <div class="nta-q-actions">
        <div class="nta-icon-btn ${isMarked ? 'marked' : ''}" id="markIconBtn" title="Mark for Review">📌</div>
        <div class="nta-icon-btn" id="themeIconBtn" title="Toggle Theme">🌙</div>
      </div>
    </div>
    <div class="nta-q-card">
      <div class="nta-q-text">${cleanQ}</div>
      ${optionsHtml}
      <div id="answerReveal"></div>
    </div>
  `;

  // Option click
  container.querySelectorAll(".nta-opt").forEach(opt => {
    opt.addEventListener("click", () => {
      if (LOCKED) return;
      const key = opt.dataset.key;
      ANSWERS[qid] = key;
      container.querySelectorAll(".nta-opt").forEach(o => o.classList.remove("selected"));
      opt.classList.add("selected");
      updateProgress();
    });
  });

  // Written box save on input
  const wb = $("writtenBox");
  if (wb) {
    wb.addEventListener("input", () => {
      ANSWERS[qid] = wb.value;
      updateProgress();
    });
  }

  // Mark btn
  $("markIconBtn")?.addEventListener("click", () => {
    MARKED[qid] = !MARKED[qid];
    updateProgress();
    renderQuestion(CURRENT_Q); // re-render to update mark icon
  });

  $("themeIconBtn")?.addEventListener("click", toggleTheme);

  // Show answer if practice mode & answered & submitted
  if (LOCKED && EXAM.meta?.include_answers && q.type === "mcq") {
    showAnswerReveal(q, qid);
  }

  // Update nav buttons
  $("btnPrev").disabled = idx === 1;
  $("btnNextArrow").disabled = idx === total;

  updateProgress();
}

function showAnswerReveal(q, qid) {
  const box = $("answerReveal");
  if (!box) return;
  const correctOpt = (q.options || []).find(o => o.key === q.answer);
  const userAns = ANSWERS[qid] || "—";
  const correct = userAns === q.answer;
  box.innerHTML = `
    <div style="
      margin-top:14px; padding:14px 16px; border-radius:12px; font-size:.87rem; line-height:1.65;
      background:${correct ? '#dcfce7' : '#fee2e2'};
      border:1.5px solid ${correct ? '#86efac' : '#fca5a5'};
      color:#111110;
    ">
      <b style="color:${correct ? '#15803d' : '#b91c1c'};">${correct ? "✅ Correct!" : "❌ Incorrect"}</b><br/>
      <span style="color:#333;"><b>Your answer:</b> ${userAns}</span><br/>
      <span style="color:#333;"><b>Correct:</b> ${q.answer}${correctOpt ? " — " + correctOpt.text : ""}</span><br/>
      <span style="color:#333;"><b>Explanation:</b> ${q.explain || "—"}</span>
    </div>
  `;
}

// ── Build palette ──
function buildPalette(total) {
  const wrap = $("paletteWrap");
  const pal  = $("qPalette");
  if (!wrap || !pal) return;
  wrap.style.display = "block";
  pal.innerHTML = "";
  for (let i = 1; i <= total; i++) {
    const d = document.createElement("div");
    d.className = "nta-p-dot";
    d.textContent = i;
    d.id = `pdot-${i}`;
    d.addEventListener("click", () => renderQuestion(i));
    pal.appendChild(d);
  }
}

// ── Collect answers for submit ──
function collectAnswers() {
  const out = {};
  if (!EXAM) return out;
  EXAM.questions.forEach((q, i) => {
    const qid = String(i + 1);
    out[qid] = ANSWERS[qid] || "";
  });
  return out;
}

// ── Render exam ──
function renderExam(exam) {
  EXAM = exam;
  EXAM_START_TIME = Date.now();
  window._photos = {};

  const meta = exam.meta || {};
  $("paperMeta").textContent = [
    meta.exam_format || "Test lele",
    meta.mode || "practice",
    meta.difficulty || "",
  ].filter(Boolean).join(" · ");

  buildPalette(exam.questions.length);
  renderQuestion(1);

  const totalMinutes = Number(meta.timer_minutes || 0);
  if (totalMinutes > 0) startTimer(totalMinutes * 60);
}

// ── Navigation ──
function goNext() {
  if (!EXAM) return;
  const total = EXAM.questions.length;
  if (CURRENT_Q < total) renderQuestion(CURRENT_Q + 1);
  else {
    // last question — prompt submit
    if (!LOCKED && confirm(`You've reached the last question. Submit the exam?`)) {
      submitExam(false);
    }
  }
}
function goPrev() {
  if (CURRENT_Q > 1) renderQuestion(CURRENT_Q - 1);
}

// ── Submit ──
async function submitExam(time_over = false) {
  if (!EXAM) return;
  if (LOCKED && !time_over) return;

  finalizeAllTimes();
  stopTimer();
  setLocked(true);

  const status = $("submitStatus");
  status.textContent = "Submitting…";

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

// ── Share ──
function buildShareText(res) {
  const topic = (EXAM?.title || "a topic").replace(/^Test:\s*/i, "");
  return `I just scored ${res.percentage}% (${res.grade}) on a "${topic}" practice test on Test lele! 🎯\nTry it free → https://test-lele-1.onrender.com`;
}

// ── Time table ──
function buildTimeTable() {
  if (!EXAM) return null;
  const totalSec = Math.round((Date.now() - EXAM_START_TIME) / 1000);
  const rows = EXAM.questions.map((q, i) => {
    const qid = String(i + 1);
    const sec = Q_TIME_SPENT[qid] || 0;
    const pct = totalSec > 0 ? Math.round((sec / totalSec) * 100) : 0;
    return `<tr>
      <td class="tc-q">Q${qid}</td>
      <td class="tc-type">${q.type || "MCQ"}</td>
      <td class="tc-time">${fmtSpent(sec)}</td>
      <td><div class="time-bar-wrap"><div class="time-bar" style="width:${Math.min(pct,100)}%"></div></div></td>
    </tr>`;
  }).join("");
  const div = document.createElement("div");
  div.className = "time-table-wrap";
  div.innerHTML = `
    <div class="result-section">
      <h3>⏱ Time Spent per Question</h3>
      <p style="font-size:.8rem;color:var(--muted);margin-bottom:10px;">Total: <b>${fmtSpent(totalSec)}</b></p>
      <table class="time-table">
        <thead><tr><th>Q#</th><th>Type</th><th>Time</th><th>Proportion</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  return div;
}

// ── Show Result ──
function showResult(res) {
  // Show answers on current question if practice
  if (EXAM?.meta?.include_answers) {
    EXAM.questions.forEach((q, i) => {
      if (q.type === "mcq") {
        // mark correct/wrong on answer_key
      }
    });
  }

  // Re-render current Q to show answer
  renderQuestion(CURRENT_Q);

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
    <div class="result-section"><h3>Missed Questions</h3><ul>${miss || "<li>None — perfect score! 🎉</li>"}</ul></div>
    <div class="result-section"><h3>Suggested Revision</h3><ul>${rev || "<li>—</li>"}</ul></div>
  `;

  const timeTable = buildTimeTable();
  if (timeTable) box.appendChild(timeTable);

  // Share buttons
  const text = encodeURIComponent(buildShareText(res));
  const shareDiv = document.createElement("div");
  shareDiv.className = "share-row";
  shareDiv.innerHTML = `
    <div class="share-label">📤 Share your result</div>
    <div class="share-btns">
      <a class="share-btn whatsapp" href="https://wa.me/?text=${text}" target="_blank">💬 WhatsApp</a>
      <a class="share-btn twitter" href="https://twitter.com/intent/tweet?text=${text}" target="_blank">🐦 Twitter/X</a>
      <button class="share-btn copy" id="copyShareBtn">📋 Copy Link</button>
    </div>`;
  box.appendChild(shareDiv);

  box.querySelector("#copyShareBtn")?.addEventListener("click", () => {
    navigator.clipboard.writeText(buildShareText(res)).then(() => {
      const btn = box.querySelector("#copyShareBtn");
      btn.innerHTML = "✅ Copied!";
      setTimeout(() => btn.innerHTML = "📋 Copy Link", 2000);
    });
  });

  // Apply answer key to palette — color answered correct/wrong
  if (res.answer_key) {
    EXAM.questions.forEach((q, i) => {
      const qid = String(i + 1);
      const key = res.answer_key[qid];
      const dot = $(`pdot-${qid}`);
      if (!dot || !key) return;
      if (key.type === "mcq") {
        const correct = ANSWERS[qid] === key.answer;
        dot.style.background = correct ? "#16a34a" : "#dc2626";
        dot.style.borderColor = correct ? "#16a34a" : "#dc2626";
        dot.style.color = "#fff";
      }
    });
  }

  box.scrollIntoView({ behavior: "smooth", block: "start" });

  setTimeout(() => {
    const modal = $("wlModal");
    if (modal && !sessionStorage.getItem("wl_shown")) {
      modal.style.display = "grid";
      sessionStorage.setItem("wl_shown", "1");
    }
  }, 4000);
}

// ── Load exam ──
async function loadExam() {
  const status = $("submitStatus");
  try {
    const r = await fetch(`/api/exam/${examId}`);
    const data = await r.json();
    if (data.error) { status.textContent = "❌ " + data.error; return; }
    if (!data.questions || data.questions.length === 0) {
      status.textContent = "❌ No questions found."; return;
    }
    renderExam(data);
  } catch (e) {
    if (status) status.textContent = "❌ Failed to load exam. Please go back and try again.";
    console.error("loadExam error:", e);
  }
}

// ── Init ──
document.addEventListener("DOMContentLoaded", async () => {
  applyTheme(localStorage.getItem("theme") || "light");

  $("themeBtn")?.addEventListener("click", toggleTheme);

  $("submitTopBtn")?.addEventListener("click", () => {
    if (LOCKED) return;
    const answered = Object.keys(ANSWERS).filter(k => ANSWERS[k] && String(ANSWERS[k]).trim()).length;
    const total = EXAM?.questions?.length || 0;
    const unanswered = total - answered;
    const msg = unanswered > 0
      ? `You have ${unanswered} unanswered question(s). Submit anyway?`
      : "Submit the exam?";
    if (confirm(msg)) submitExam(false);
  });

  $("btnPrev")?.addEventListener("click", goPrev);
  $("btnNextArrow")?.addEventListener("click", goNext);

  $("btnMark")?.addEventListener("click", () => {
    const qid = String(CURRENT_Q);
    MARKED[qid] = !MARKED[qid];
    updateProgress();
    renderQuestion(CURRENT_Q);
  });

  $("btnClear")?.addEventListener("click", () => {
    const qid = String(CURRENT_Q);
    delete ANSWERS[qid];
    updateProgress();
    renderQuestion(CURRENT_Q);
  });

  $("btnNext")?.addEventListener("click", () => {
    // "Save & Next" — answer is already saved on click, just go next
    goNext();
  });

  $("timeOverOk")?.addEventListener("click", () => {
    $("timeOverModal").style.display = "none";
  });

  if (!examId) {
    $("submitStatus").textContent = "Error: missing exam ID in URL.";
    return;
  }
  await loadExam();
});
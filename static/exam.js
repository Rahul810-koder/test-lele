// ===== Test lele — exam.js =====
const examId = (window.location.pathname.split("/").filter(Boolean).pop() || "").trim();
const $ = (id) => document.getElementById(id);

let EXAM = null;
let LOCKED = false;
let TIMER_ID = null;
let TIME_OVER_AUTO = false;

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

    // Color warning
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
  // Also lock photo areas visually
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

// -- Render --
function renderExam(exam) {
  EXAM = exam;
  window._photos = {}; // photo store: { qid: [dataURL, ...] }

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

    // Detect difficulty from question text
    const diffMatch = q.q.match(/\[(EASY|MEDIUM|HARD)\]/i);
    const diff = diffMatch ? diffMatch[1].toLowerCase() : "medium";
    const cleanQ = q.q.replace(/\[(EASY|MEDIUM|HARD)\]\s*/i, "").trim();

    const card = document.createElement("div");
    card.className = "q-card";
    card.dataset.qid = qid;

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
      // Written answer: type or photo tabs
      const tabs = document.createElement("div");
      tabs.className = "answer-tabs";
      tabs.innerHTML = `
        <button type="button" class="answer-tab active" data-tab="type">✏️ Type</button>
        <button type="button" class="answer-tab" data-tab="photo">📷 Upload Photo</button>
      `;
      card.appendChild(tabs);

      // Type panel
      const typePanel = document.createElement("div");
      typePanel.dataset.panel = "type";
      const ta = document.createElement("textarea");
      ta.className = "answer-box";
      ta.name = `q_${qid}`;
      ta.placeholder = "Write your answer here…";
      ta.addEventListener("input", updateProgress);
      typePanel.appendChild(ta);
      card.appendChild(typePanel);

      // Photo panel
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

      // Tab switching
      tabs.querySelectorAll(".answer-tab").forEach(tab => {
        tab.addEventListener("click", () => {
          tabs.querySelectorAll(".answer-tab").forEach(t => t.classList.remove("active"));
          tab.classList.add("active");
          const target = tab.dataset.tab;
          typePanel.style.display = target === "type" ? "" : "none";
          photoPanel.style.display = target === "photo" ? "" : "none";
        });
      });

      // Photo input handler
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
        e.target.value = ""; // reset so same file can be re-added
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

  // Start timer
  const tmin = Number(meta.timer_minutes || 0);
  if (tmin > 0) startTimer(tmin * 60);

  document.addEventListener("change", updateProgress);
  updateProgress();
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

  stopTimer(); // ⭐ Timer stops on submit
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
      <h3>Missing Points</h3>
      <ul>${miss || "<li>None — great job!</li>"}</ul>
    </div>
    <div class="result-section">
      <h3>Suggested Revision</h3>
      <ul>${rev || "<li>—</li>"}</ul>
    </div>
  `;

  // Show answer keys on each card
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
    stopTimer();       // ⭐ Timer stops immediately on manual submit
    await submitExam(false);
  });

  if (!examId) {
    $("submitStatus").textContent = "Error: missing exam ID in URL.";
    return;
  }
  await loadExam();
});
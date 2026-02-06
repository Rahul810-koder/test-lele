function applyTheme(theme){
  document.body.setAttribute("data-theme", theme);
  localStorage.setItem("theme", theme);
}

const savedTheme = localStorage.getItem("theme") || "dark";
applyTheme(savedTheme);

document.getElementById("themeBtn").addEventListener("click", () => {
  const cur = document.body.getAttribute("data-theme") || "dark";
  applyTheme(cur === "dark" ? "light" : "dark");
});

document.getElementById("printBtn").addEventListener("click", () => window.print());

let allowReveal = false;
let timerInterval = null;
function updateProgress(){
  const pill = document.getElementById("progressPill");
  if (!pill) return;

  const total = document.querySelectorAll(".q").length;

  // answered MCQ = radio selected per question
  const answeredMCQ = new Set(
    Array.from(document.querySelectorAll('input[type=radio]:checked'))
      .map(x => x.name)
  ).size;

  // answered written = textarea has text
  const answeredWritten = Array.from(document.querySelectorAll("textarea[name]"))
    .filter(t => (t.value || "").trim().length > 0).length;

  const answered = answeredMCQ + answeredWritten;

  pill.textContent = `Q ${Math.min(answered + 1, total)}/${total} • ${answered} answered`;
}

function lockExamUI(){
  // Disable all inputs
  document.querySelectorAll('input, textarea, select, button.kbtn').forEach(el => {
    // allow theme/print buttons to still work
    if (el.id === "themeBtn" || el.id === "printBtn") return;
    el.disabled = true;
  });

  // Optional: change submit button text
  const submitBtn = document.getElementById("submitBtn");
  if (submitBtn) submitBtn.textContent = "Time Over ✅ Submitted";

  const status = document.getElementById("submitStatus");
  if (status) status.textContent = "Time is over. Answers are locked.";
}
function showTimeOverModal(){
  const m = document.getElementById("timeOverModal");
  if (!m) return;
  m.style.display = "flex";
}

document.addEventListener("click", (e) => {
  if (e.target && e.target.id === "timeOverOk") {
    const m = document.getElementById("timeOverModal");
    if (m) m.style.display = "none";
  }
});


function formatMMSS(totalSeconds){
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
}

function startTimer(minutes){
  const pill = document.getElementById("timerPill");
  if (!minutes || minutes <= 0) {
    pill.style.display = "none";
    return;
  }
  pill.style.display = "inline-flex";

  const key = `timer_remaining_${examId}`;
  let remaining = parseInt(localStorage.getItem(key) || "", 10);
  if (!Number.isFinite(remaining) || remaining <= 0) remaining = minutes * 60;

  pill.textContent = `⏳ ${formatMMSS(remaining)}`;

  if (timerInterval) clearInterval(timerInterval);

  timerInterval = setInterval(() => {
    remaining -= 1;
    localStorage.setItem(key, String(remaining));
    pill.textContent = `⏳ ${formatMMSS(Math.max(0, remaining))}`;

      if (remaining <= 0) {
      clearInterval(timerInterval);
      pill.textContent = "⏳ 00:00";

      // Lock UI first so user can't change anything
      lockExamUI();
     showTimeOverModal();

      // Auto-submit after lock (small delay so UI locks properly)
      setTimeout(() => {
        const btn = document.getElementById("submitBtn");
        if (btn && !btn.disabled) btn.click();
      }, 200);
    }

  }, 1000);
}

function esc(s){
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

function collectAnswers(){
  const answers = {};
  document.querySelectorAll("input[type=radio]:checked").forEach(r => {
    answers[r.name] = r.value;
  });
  document.querySelectorAll("textarea[name]").forEach(t => {
    answers[t.name] = t.value;
  });
  return answers;
}

function renderPaper(payload){
  const { mode, meta, paper } = payload;
  allowReveal = (mode === "practice");
    updateProgress();

  // update progress whenever user changes answers
  document.addEventListener("change", updateProgress);
  document.addEventListener("input", updateProgress);

  document.getElementById("subline").textContent =
    `${meta.difficulty} • ${meta.qtype} • ${meta.n_questions} Qs • mode: ${mode}`;

  startTimer(parseInt(meta.timer_minutes || 0, 10));

  const container = document.getElementById("paper");
  container.innerHTML = `
    <h2 class="paperTitle">${esc(paper.title || "Test Paper")}</h2>
    <div class="inst">
      ${(paper.instructions || []).map(x => `<div>• ${esc(x)}</div>`).join("")}
    </div>
  `;

  (paper.sections || []).forEach(sec => {
    const secEl = document.createElement("div");
    secEl.className = "section";
    secEl.innerHTML = `<div class="section-title">${esc(sec.name || "Section")}</div>`;
    container.appendChild(secEl);

    (sec.questions || []).forEach(q => {
      const qEl = document.createElement("div");
      qEl.className = "q";

      const opts = (q.options || []).map((o, i) => {
        const letter = ["A","B","C","D"][i] || "";
        return `
          <label class="opt">
            <input type="radio" name="${esc(q.id)}" value="${letter}">
            <div>${esc(o)}</div>
          </label>
        `;
      }).join("");

      qEl.innerHTML = `
        <div class="qhead">
          <div class="qid">${esc(q.id)} <span class="qmeta">• ${esc((q.type||"").toUpperCase())} • ${esc((q.difficulty||"").toUpperCase())}</span></div>
          <div class="qmeta">${esc(q.marks)} marks</div>
        </div>
        <div class="prompt">${esc(q.prompt)}</div>

        <div class="answer-area">
          ${q.type === "mcq"
            ? `<div class="opts">${opts}</div>`
            : `<textarea class="ta" name="${esc(q.id)}" placeholder="Write your answer…"></textarea>`
          }
        </div>

        <button class="kbtn" type="button" style="${allowReveal ? "" : "display:none"}">🔎 Reveal Answer Key</button>
        <div class="key" style="display:none">
          <div><b>Answer:</b> ${esc(q.answer || "")}</div>
          ${q.explanation ? `<div class="kp"><b>Explanation:</b> ${esc(q.explanation)}</div>` : ""}
          ${(q.key_points && q.key_points.length) ? `<div class="kp"><b>Key points:</b> ${esc(q.key_points.join(" • "))}</div>` : ""}
        </div>
      `;

      if (allowReveal) {
        const btn = qEl.querySelector(".kbtn");
        const key = qEl.querySelector(".key");
        btn.addEventListener("click", () => {
          key.style.display = (key.style.display === "block") ? "none" : "block";
        });
      }

      secEl.appendChild(qEl);
    });
  });
}

async function loadExam(){
  const res = await fetch(`/api/exam/${examId}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || "Failed to load exam");
  renderPaper(data);
}

document.getElementById("submitBtn").addEventListener("click", async () => {
  const status = document.getElementById("submitStatus");
  status.textContent = "Submitting…";

  const answers = collectAnswers();

  const res = await fetch(`/api/submit/${examId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ answers })
  });
  const data = await res.json();
  if (!res.ok) {
    status.textContent = "Error: " + (data.detail || "Submit failed");
    return;
  }

  // stop timer
  if (timerInterval) clearInterval(timerInterval);
  localStorage.removeItem(`timer_remaining_${examId}`);

   const r = data.result;

  // Build mistakes list (top 6)
  const mistakes = (r.per_question || [])
    .filter(pq => (pq.type === "mcq" && pq.status !== "correct") || (pq.type === "written" && pq.score < pq.marks))
    .slice(0, 6);

  const mistakesHtml = mistakes.length
    ? mistakes.map(pq => {
        if (pq.type === "mcq") {
          return `
            <div class="item bad">
              <div><b>${esc(pq.id)}</b> — Wrong</div>
              <div class="muted">Your answer: <b>${esc(pq.your_answer || "-")}</b> | Correct: <b>${esc(pq.correct_answer || "-")}</b></div>
              ${pq.explanation ? `<div class="muted">${esc(pq.explanation)}</div>` : ""}
            </div>
          `;
        } else {
          const missing = (pq.missing_points || []).slice(0, 4);
          return `
            <div class="item bad">
              <div><b>${esc(pq.id)}</b> — ${pq.score}/${pq.marks}</div>
              ${missing.length ? `<div class="muted"><b>Missing:</b> ${esc(missing.join(" • "))}</div>` : ""}
            </div>
          `;
        }
      }).join("")
    : `<div class="item good">No major mistakes detected ✅</div>`;

  const revise = (r.feedback?.suggested_revision_topics || []).slice(0, 8);
  const reviseHtml = revise.length
    ? revise.map(t => `<span class="chip">${esc(t)}</span>`).join("")
    : `<span class="muted">No revision topics listed.</span>`;

  const improve = (r.feedback?.how_to_improve || []).slice(0, 6);
  const improveHtml = improve.length
    ? improve.map(x => `<li>${esc(x)}</li>`).join("")
    : `<li>Keep practicing with timed tests.</li>`;

  document.getElementById("result").innerHTML = `
    <h3>Result</h3>

    <div class="resultBox">
      <div class="big">${esc(r.percentage)}%</div>
      <div>
        <div><b>Score:</b> ${r.scored_marks}/${r.total_marks}</div>
        <div><b>Grade:</b> ${esc(r.grade)}</div>
        <div class="muted">${esc(r.feedback?.summary || "")}</div>
      </div>
    </div>

    <h4>How to improve (next attempt)</h4>
    <ul class="list">${improveHtml}</ul>

    <h4>Mistakes to fix</h4>
    <div class="stack">${mistakesHtml}</div>

    <h4>Suggested revision topics</h4>
    <div class="chips">${reviseHtml}</div>
  `;


  status.textContent = "Submitted ✅";
    lockExamUI();


});

loadExam().catch(err => {
  document.getElementById("paper").innerHTML = `<div class="status">Error: ${esc(err.message || err)}</div>`;
});

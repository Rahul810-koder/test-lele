// ===== ExamGen exam page logic =====
const examId = (window.location.pathname.split("/").filter(Boolean).pop() || "").trim();
const $ = (id) => document.getElementById(id);

let EXAM = null;
let LOCKED = false;
let TIMER = null;
let timeOverAuto = false;

function applyTheme(theme){
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("theme", theme);
}

function toggleTheme(){
  const cur = document.documentElement.getAttribute("data-theme") || "light";
  applyTheme(cur === "dark" ? "light" : "dark");
}

function fmtTime(sec){
  const m = String(Math.floor(sec / 60)).padStart(2,"0");
  const s = String(sec % 60).padStart(2,"0");
  return `${m}:${s}`;
}

function setLocked(on){
  LOCKED = on;
  // disable inputs/textareas
  document.querySelectorAll("input, textarea, button.kbtn").forEach(el => {
    if (el.id === "themeBtn" || el.id === "printBtn") return;
    if (el.id === "timeOverOk") return;
    if (el.id === "submitBtn") return; // submit stays clickable (but we auto submit)
    el.disabled = on;
  });
}

function collectAnswers(){
  const answers = {};
  EXAM.questions.forEach(q => {
    const qid = String(q.id);
    if (q.type === "mcq") {
      const picked = document.querySelector(`input[name="q_${qid}"]:checked`);
      answers[qid] = picked ? picked.value : "";
    } else {
      const ta = document.querySelector(`textarea[name="q_${qid}"]`);
      answers[qid] = ta ? ta.value : "";
    }
  });
  return answers;
}

function updateProgress(){
  if (!EXAM) return;
  let answered = 0;
  EXAM.questions.forEach(q => {
    const qid = String(q.id);
    if (q.type === "mcq") {
      const picked = document.querySelector(`input[name="q_${qid}"]:checked`);
      if (picked) answered++;
    } else {
      const ta = document.querySelector(`textarea[name="q_${qid}"]`);
      if (ta && ta.value.trim().length > 0) answered++;
    }
  });
  $("progressPill").textContent = `Q ${EXAM.questions.length}/${EXAM.questions.length} • ${answered} answered`;
}

function renderExam(exam){
  EXAM = exam;

  $("paperTitle").textContent = exam.title || "Test Paper";
  const meta = exam.meta || {};
  $("paperMeta").textContent = `${meta.mode || "practice"} • ${meta.difficulty || ""} • ${meta.qtype || ""}`;
  $("paperInfo").textContent = (meta.mode === "exam")
    ? "Exam Mode: answers will be shown after submission. Use clear steps."
    : "Practice Mode: you can reveal answers (if enabled).";

  const wrap = $("paper");
  wrap.innerHTML = "";

  exam.questions.forEach((q) => {
    const qid = String(q.id);
    const card = document.createElement("div");
    card.className = "q";

    const head = document.createElement("div");
    head.className = "qHead";

    const tag = document.createElement("div");
    tag.className = "qTag";
    tag.textContent = `Q${qid} • ${q.type.toUpperCase()} ${q.q.includes("[HARD]") ? "• HARD" : q.q.includes("[MEDIUM]") ? "• MEDIUM" : "• EASY"}`;

    const marks = document.createElement("div");
    marks.className = "qMarks";
    marks.textContent = q.type === "mcq" ? "1 marks" : `${q.marks || 3} marks`;

    head.appendChild(tag);
    head.appendChild(marks);

    const text = document.createElement("div");
    text.className = "qText";
    text.textContent = q.q;

    card.appendChild(head);
    card.appendChild(text);

    if (q.type === "mcq") {
      (q.options || []).forEach(opt => {
        const lab = document.createElement("label");
        lab.className = "opt";
        lab.innerHTML = `
          <input type="radio" name="q_${qid}" value="${opt.key}">
          <span><b>${opt.key}.</b> ${opt.text}</span>
        `;
        card.appendChild(lab);
      });

      // Practice reveal button only if answer present
      if (meta.mode === "practice" && meta.include_answers) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "kbtn";
        btn.textContent = "Reveal Answer Key";
        btn.addEventListener("click", () => {
          const box = document.createElement("div");
          box.className = "status";
          box.style.marginTop = "10px";
          box.innerHTML = `<b>Answer:</b> ${q.answer} <br/><b>Why:</b> ${q.explain || ""}`;
          btn.replaceWith(box);
        });
        card.appendChild(btn);
      }
    } else {
      const ta = document.createElement("textarea");
      ta.className = "answerBox";
      ta.name = `q_${qid}`;
      ta.placeholder = "Write your answer…";
      ta.addEventListener("input", updateProgress);
      card.appendChild(ta);

      if (meta.mode === "practice" && meta.include_answers) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "kbtn";
        btn.textContent = "Reveal Model Answer";
        btn.addEventListener("click", () => {
          const box = document.createElement("div");
          box.className = "status";
          box.style.marginTop = "10px";
          const kp = (q.key_points || []).map(x => `<li>${x}</li>`).join("");
          box.innerHTML = `<b>Model:</b> ${q.model || ""}<br/><b>Key points:</b><ul>${kp}</ul>`;
          btn.replaceWith(box);
        });
        card.appendChild(btn);
      }
    }

    wrap.appendChild(card);
  });

  // Timer
  const tmin = Number(meta.timer_minutes || 0);
  if (tmin > 0) startTimer(tmin * 60);

  // Bind progress
  document.addEventListener("change", updateProgress);
  updateProgress();
}

function startTimer(seconds){
  const pill = $("timerPill");
  pill.style.display = "inline-flex";

  let left = seconds;
  pill.textContent = `⏳ ${fmtTime(left)}`;

  TIMER = setInterval(async () => {
    left--;
    if (left <= 0) {
      clearInterval(TIMER);
      pill.textContent = `⏳ 00:00`;
      timeOverAuto = true;
      setLocked(true);
      $("timeOverModal").style.display = "grid";
      await submitExam(true); // auto submit
      return;
    }
    pill.textContent = `⏳ ${fmtTime(left)}`;
  }, 1000);
}

async function submitExam(time_over=false){
  if (!EXAM || LOCKED && !time_over) return;

  setLocked(true);
  $("submitStatus").textContent = "Submitting…";

  const payload = {
    answers: collectAnswers(),
    time_over: time_over
  };

  const r = await fetch(`/api/submit/${examId}`, {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify(payload)
  });

  const data = await r.json();
  if (!data.ok) {
    $("submitStatus").textContent = "Submit failed.";
    return;
  }

  $("submitStatus").textContent = "Submitted ✅";
  showResult(data.result);
}

function showResult(res){
  const box = $("result");
  box.style.display = "block";

  const miss = (res.missing_points || []).map(x => `<li>${x}</li>`).join("");
  const rev = (res.suggested_revision || []).map(x => `<li>${x}</li>`).join("");

  box.innerHTML = `
    <h2 style="margin-top:0">Result</h2>
    <div class="status"><b>Score:</b> ${res.score} &nbsp; <b>Percentage:</b> ${res.percentage}% &nbsp; <b>Grade:</b> ${res.grade}</div>
    <div class="status" style="margin-top:8px"><b>Feedback:</b> ${res.feedback}</div>

    <h3>Missing points</h3>
    <ul>${miss || "<li>—</li>"}</ul>

    <h3>Suggested revision</h3>
    <ul>${rev || "<li>—</li>"}</ul>

    <h3>Answer key</h3>
    <div class="status">Answers are visible after submission (exam mode) or via reveal (practice mode).</div>
  `;

  // After submit: show answer key below each question (for exam mode)
  if (res.answer_key) {
    Object.keys(res.answer_key).forEach(qid => {
      const key = res.answer_key[qid];
      const qCards = document.querySelectorAll(".q");
      const idx = Number(qid) - 1;
      const card = qCards[idx];
      if (!card) return;

      const add = document.createElement("div");
      add.className = "status";
      add.style.marginTop = "10px";

      if (key.type === "mcq") {
        add.innerHTML = `<b>Answer:</b> ${key.answer}<br/><b>Why:</b> ${key.explain || ""}`;
      } else {
        const kp = (key.key_points || []).map(x => `<li>${x}</li>`).join("");
        add.innerHTML = `<b>Model:</b> ${key.model || ""}<br/><b>Key points:</b><ul>${kp}</ul>`;
      }
      card.appendChild(add);
    });
  }
}

async function loadExam(){
  const r = await fetch(`/api/exam/${examId}`);
  const data = await r.json();
  if (data.error) {
    $("submitStatus").textContent = data.error;
    return;
  }
  renderExam(data);
}

document.addEventListener("DOMContentLoaded", async () => {
  // theme
  applyTheme(localStorage.getItem("theme") || "light");
  $("themeBtn")?.addEventListener("click", toggleTheme);
  $("printBtn")?.addEventListener("click", () => window.print());

  $("timeOverOk")?.addEventListener("click", () => {
    $("timeOverModal").style.display = "none";
  });

  $("submitBtn")?.addEventListener("click", async () => {
    if (timeOverAuto) return; // already submitted
    await submitExam(false);
  });

  if (!examId) {
    $("submitStatus").textContent = "Error: examId missing in URL.";
    return;
  }
  await loadExam();
});

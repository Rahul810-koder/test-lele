const form = document.getElementById("genForm");
const statusEl = document.getElementById("status");

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  statusEl.textContent = "Generating…";

  const fd = new FormData();
  fd.append("topic_text", document.getElementById("topic_text").value || "");
  fd.append("difficulty", document.getElementById("difficulty").value);
  fd.append("qtype", document.getElementById("qtype").value);
  fd.append("n_questions", document.getElementById("n_questions").value || "15");
  fd.append("timer_minutes", document.getElementById("timer_minutes").value || "0");
  fd.append("need_explanations", document.getElementById("need_explanations").value);

  const mode = document.querySelector('input[name="mode"]:checked')?.value || "practice";
  fd.append("mode", mode);

  const fileInput = document.getElementById("file");
  if (fileInput.files && fileInput.files[0]) {
    fd.append("file", fileInput.files[0]);
  }

  try {
    const res = await fetch("/api/generate", { method: "POST", body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Generate failed");

    statusEl.textContent = "Done. Opening exam…";
    window.location.href = data.redirect_url;
  } catch (err) {
    statusEl.textContent = "Error: " + (err.message || err);
  }
});

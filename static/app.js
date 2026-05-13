(function () {

  // ── File upload label ──
  const fileInput = document.querySelector(".file-upload input");
  const fileText  = document.querySelector(".file-upload .file-text");
  fileInput?.addEventListener("change", () => {
    if (fileText) fileText.textContent = fileInput.files[0]?.name || "No file chosen";
  });

  // ── Waitlist Modal ──
  const modal      = document.getElementById("wlModal");
  const openBtn    = document.getElementById("waitlistBtn");
  const closeBtn   = document.getElementById("wlClose");
  const wlForm     = document.getElementById("wlForm");
  const wlSuccess  = document.getElementById("wlSuccess");

  function openModal() {
    if (modal) modal.style.display = "grid";
  }
  function closeModal() {
    if (modal) modal.style.display = "none";
  }

  openBtn?.addEventListener("click", openModal);
  closeBtn?.addEventListener("click", closeModal);

  // Close if clicking outside the card
  modal?.addEventListener("click", (e) => {
    if (e.target === modal) closeModal();
  });

  // Form submit
  wlForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = wlForm.querySelector("button[type=submit]");
    btn.disabled = true;
    btn.textContent = "Submitting…";

    try {
      const res = await fetch(wlForm.action, {
        method: "POST",
        body: new FormData(wlForm),
        headers: { "Accept": "application/json" }
      });

      if (res.ok) {
        wlForm.style.display = "none";
        wlSuccess.style.display = "block";
        // Auto close after 3 seconds
        setTimeout(closeModal, 3000);
      } else {
        btn.disabled = false;
        btn.textContent = "Try again →";
      }
    } catch {
      btn.disabled = false;
      btn.textContent = "Try again →";
    }
  });

})();
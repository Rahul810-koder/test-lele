(function () {

  // ── File upload label ──
  const fileInput = document.querySelector(".file-upload input");
  const fileText  = document.querySelector(".file-upload .file-text");
  fileInput?.addEventListener("change", () => {
    if (fileText) fileText.textContent = fileInput.files[0]?.name || "No file chosen";
  });

})();
(function () {
  const saved = localStorage.getItem("theme") || "light";
  document.documentElement.setAttribute("data-theme", saved);

  document.getElementById("themeBtn")?.addEventListener("click", () => {
    const cur = document.documentElement.getAttribute("data-theme") || "light";
    const next = cur === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("theme", next);
  });

  // File upload label
  const fileInput = document.querySelector(".file-upload input");
  const fileText = document.querySelector(".file-upload .file-text");
  fileInput?.addEventListener("change", () => {
    if (fileText) fileText.textContent = fileInput.files[0]?.name || "No file chosen";
  });
 })();
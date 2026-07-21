// Comportamiento compartido por las páginas públicas (vacantes, postular, estado).
document.getElementById("navToggle")?.addEventListener("click", () => {
  document.querySelector("nav.main-nav")?.classList.toggle("open");
});

document.querySelectorAll(".anio-actual").forEach((el) => {
  el.textContent = new Date().getFullYear();
});

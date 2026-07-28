import { requireAuth, wireLogoutButton, tienePermiso } from "./utils.js";

const { user, perfil } = await requireAuth();
wireLogoutButton();

document.getElementById("saludo").textContent = `Bienvenido/a, ${perfil.nombre || user.email}`.trim();

if (perfil.rol !== "admin") {
  document.querySelectorAll(".solo-admin").forEach((el) => el.remove());
}
document.querySelectorAll("[data-permiso]").forEach((el) => {
  if (!tienePermiso(perfil, el.dataset.permiso)) el.remove();
});

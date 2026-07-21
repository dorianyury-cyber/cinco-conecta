import { collection, onSnapshot } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js";
import { db, functions, requireAuth, wireLogoutButton, setActiveNav, showAlert, clearAlert, friendlyError } from "./utils.js";

const { perfil } = await requireAuth();
wireLogoutButton();
setActiveNav();

if (perfil.rol !== "admin") {
  window.location.href = "reconocimientos.html";
}

const tabla = document.getElementById("tablaEmpleados");
const form = document.getElementById("invitarForm");
const alertBox = document.getElementById("alertBox");
const invitarBtn = document.getElementById("invitarBtn");

onSnapshot(collection(db, "staff"), (snap) => {
  const empleados = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  if (empleados.length === 0) {
    tabla.innerHTML = '<tr><td colspan="3" class="text-muted text-center">Sin empleados registrados.</td></tr>';
    return;
  }
  tabla.innerHTML = empleados
    .sort((a, b) => (a.nombre || "").localeCompare(b.nombre || "", "es"))
    .map((e) => `
      <tr>
        <td><b>${e.nombre || "-"}</b></td>
        <td>${e.rol === "admin" ? '<span class="badge gold">Admin</span>' : '<span class="badge muted">Empleado</span>'}</td>
        <td>${e.estado === "activo" ? '<span class="badge ok">Activo</span>' : '<span class="badge danger">Bloqueado</span>'}</td>
      </tr>
    `)
    .join("");
}, (err) => {
  tabla.innerHTML = `<tr><td colspan="3" class="text-muted text-center">${friendlyError(err)}</td></tr>`;
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearAlert(alertBox);
  invitarBtn.disabled = true;
  invitarBtn.textContent = "Enviando...";

  try {
    const llamada = httpsCallable(functions, "invitarEmpleado");
    await llamada({
      nombre: document.getElementById("nombreEmpleado").value.trim(),
      correo: document.getElementById("correoEmpleado").value.trim()
    });
    showAlert(alertBox, "¡Invitación enviada! Le llegará un correo con sus datos de acceso.", "success");
    form.reset();
  } catch (err) {
    showAlert(alertBox, friendlyError(err), "error");
  } finally {
    invitarBtn.disabled = false;
    invitarBtn.textContent = "Enviar invitación";
  }
});

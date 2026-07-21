import { collection, onSnapshot } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js";
import { db, functions, requireAuth, wireLogoutButton, setActiveNav, showAlert, clearAlert, friendlyError } from "./utils.js";

const { user, perfil } = await requireAuth();
wireLogoutButton();
setActiveNav();

if (perfil.rol !== "admin") {
  window.location.href = "reconocimientos.html";
}

const uid = user.uid;
const tabla = document.getElementById("tablaEmpleados");
const form = document.getElementById("invitarForm");
const alertBox = document.getElementById("alertBox");
const invitarBtn = document.getElementById("invitarBtn");

let empleados = [];

function render() {
  if (empleados.length === 0) {
    tabla.innerHTML = '<tr><td colspan="5" class="text-muted text-center">Sin empleados registrados.</td></tr>';
    return;
  }
  tabla.innerHTML = empleados
    .sort((a, b) => (a.nombre || "").localeCompare(b.nombre || "", "es"))
    .map((e) => {
      const esUnoMismo = e.id === uid;
      const bloqueado = e.estado !== "activo";
      return `
        <tr>
          <td><b>${e.nombre || "-"}</b>${e.debeCambiarPassword ? ' <span class="badge warn text-xs">Pendiente 1er cambio de clave</span>' : ""}</td>
          <td>${e.correo || "-"}</td>
          <td>${e.rol === "admin" ? '<span class="badge gold">Admin</span>' : '<span class="badge muted">Empleado</span>'}</td>
          <td>${!bloqueado ? '<span class="badge ok">Activo</span>' : '<span class="badge danger">Bloqueado</span>'}</td>
          <td>
            <button class="icon-btn" data-renombrar="${e.id}" data-nombre="${(e.nombre || "").replace(/"/g, "&quot;")}">✏️ Nombre</button>
            <button class="icon-btn" data-reenviar="${e.id}">✉️ Reenviar acceso</button>
            ${esUnoMismo ? "" : `
              <button class="icon-btn" data-rol="${e.id}" data-rol-actual="${e.rol}">🔧 ${e.rol === "admin" ? "Quitar admin" : "Hacer admin"}</button>
              <button class="icon-btn ${bloqueado ? "" : "danger"}" data-estado="${e.id}" data-estado-actual="${e.estado}">${bloqueado ? "✅ Activar" : "🚫 Bloquear"}</button>
              <button class="icon-btn danger" data-eliminar="${e.id}">🗑️ Eliminar</button>
            `}
          </td>
        </tr>
      `;
    })
    .join("");
}

onSnapshot(collection(db, "staff"), (snap) => {
  empleados = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  render();
}, (err) => {
  tabla.innerHTML = `<tr><td colspan="5" class="text-muted text-center">${friendlyError(err)}</td></tr>`;
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

// ---- Renombrar (modal) ----

const modalBackdrop = document.getElementById("modalBackdrop");
const renombrarForm = document.getElementById("renombrarForm");
const renombrarAlertBox = document.getElementById("renombrarAlertBox");

renombrarForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearAlert(renombrarAlertBox);
  const btn = document.getElementById("renombrarGuardarBtn");
  btn.disabled = true;
  try {
    const llamada = httpsCallable(functions, "renombrarEmpleado");
    await llamada({
      uid: document.getElementById("renombrarUid").value,
      nombre: document.getElementById("renombrarNombre").value.trim()
    });
    modalBackdrop.classList.remove("open");
  } catch (err) {
    showAlert(renombrarAlertBox, friendlyError(err), "error");
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("renombrarCancelarBtn").addEventListener("click", () => modalBackdrop.classList.remove("open"));

// ---- Acciones de la tabla ----

tabla.addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;

  if (btn.dataset.renombrar) {
    clearAlert(renombrarAlertBox);
    document.getElementById("renombrarUid").value = btn.dataset.renombrar;
    document.getElementById("renombrarNombre").value = btn.dataset.nombre || "";
    modalBackdrop.classList.add("open");
    return;
  }

  if (btn.dataset.reenviar) {
    if (!confirm("¿Generar una nueva contraseña temporal y reenviarla por correo a este empleado?")) return;
    btn.disabled = true;
    try {
      await httpsCallable(functions, "reenviarInvitacion")({ uid: btn.dataset.reenviar });
      alert("Se envió una nueva contraseña temporal por correo.");
    } catch (err) {
      alert(friendlyError(err));
    } finally {
      btn.disabled = false;
    }
    return;
  }

  if (btn.dataset.rol) {
    const nuevoRol = btn.dataset.rolActual === "admin" ? "empleado" : "admin";
    const mensaje = nuevoRol === "admin"
      ? "¿Convertir a este empleado en administrador? Podrá gestionar empleados, vacantes y candidatos."
      : "¿Quitarle el rol de administrador a este empleado?";
    if (!confirm(mensaje)) return;
    try {
      await httpsCallable(functions, "cambiarRolEmpleado")({ uid: btn.dataset.rol, rol: nuevoRol });
    } catch (err) {
      alert(friendlyError(err));
    }
    return;
  }

  if (btn.dataset.estado) {
    const nuevoEstado = btn.dataset.estadoActual === "activo" ? "bloqueado" : "activo";
    if (nuevoEstado === "bloqueado" && !confirm("¿Bloquear a este empleado? No podrá volver a ingresar hasta que lo actives de nuevo.")) return;
    try {
      await httpsCallable(functions, "cambiarEstadoEmpleado")({ uid: btn.dataset.estado, estado: nuevoEstado });
    } catch (err) {
      alert(friendlyError(err));
    }
    return;
  }

  if (btn.dataset.eliminar) {
    if (!confirm("¿Eliminar definitivamente a este empleado? Perderá el acceso a Cinco Conecta y esta acción no se puede deshacer.")) return;
    try {
      await httpsCallable(functions, "eliminarEmpleado")({ uid: btn.dataset.eliminar });
    } catch (err) {
      alert(friendlyError(err));
    }
  }
});

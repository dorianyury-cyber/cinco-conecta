import { collection, onSnapshot } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js";
import { db, functions, requireAuth, wireLogoutButton, setActiveNav, showAlert, clearAlert, friendlyError, AREAS } from "./utils.js";
import { ExcelJS, descargarWorkbook, estilizarEncabezado, ajustarAnchoColumnas, leerWorkbook, mapaEncabezados, valorCelda, filasConDatos } from "./excel.js";

function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
    tabla.innerHTML = '<tr><td colspan="7" class="text-muted text-center">Sin empleados registrados.</td></tr>';
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
          <td>${e.cargo || "-"}</td>
          <td>${AREAS[e.area] || "-"}</td>
          <td>${e.rol === "admin" ? '<span class="badge gold">Admin</span>' : '<span class="badge muted">Empleado</span>'}</td>
          <td>${!bloqueado ? '<span class="badge ok">Activo</span>' : '<span class="badge danger">Bloqueado</span>'}</td>
          <td>
            <button class="icon-btn" data-editar="${e.id}">✏️ Editar datos</button>
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

// Los selects "Jefe inmediato" (alta y edición) se repueblan cada vez que
// cambia la lista de empleados, para siempre ofrecer el personal ya
// cargado. `excluirUid` evita que un empleado pueda elegirse a sí mismo
// como su propio jefe (la Cloud Function igual lo valida, esto es solo UX).
function poblarSelectsJefe() {
  const opciones = empleados
    .slice()
    .sort((a, b) => (a.nombre || "").localeCompare(b.nombre || "", "es"))
    .map((e) => `<option value="${e.id}">${(e.nombre || e.correo || "-").replace(/"/g, "&quot;")}</option>`)
    .join("");

  const jefeInvitar = document.getElementById("jefeEmpleado");
  const valorPrevioInvitar = jefeInvitar.value;
  jefeInvitar.innerHTML = '<option value="">Sin especificar</option>' + opciones;
  jefeInvitar.value = valorPrevioInvitar;

  const jefeEditar = document.getElementById("editarJefe");
  const uidEnEdicion = document.getElementById("editarUid").value;
  const valorPrevioEditar = jefeEditar.value;
  jefeEditar.innerHTML = '<option value="">Sin especificar</option>' + empleados
    .slice()
    .filter((e) => e.id !== uidEnEdicion)
    .sort((a, b) => (a.nombre || "").localeCompare(b.nombre || "", "es"))
    .map((e) => `<option value="${e.id}">${(e.nombre || e.correo || "-").replace(/"/g, "&quot;")}</option>`)
    .join("");
  jefeEditar.value = valorPrevioEditar;
}

onSnapshot(collection(db, "staff"), (snap) => {
  empleados = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  render();
  poblarSelectsJefe();
}, (err) => {
  tabla.innerHTML = `<tr><td colspan="7" class="text-muted text-center">${friendlyError(err)}</td></tr>`;
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
      correo: document.getElementById("correoEmpleado").value.trim(),
      cedula: document.getElementById("cedulaEmpleado").value.trim(),
      telefono: document.getElementById("telefonoEmpleado").value.trim(),
      cargo: document.getElementById("cargoEmpleado").value.trim(),
      area: document.getElementById("areaEmpleado").value,
      jefeInmediatoUid: document.getElementById("jefeEmpleado").value,
      fechaIngreso: document.getElementById("fechaIngresoEmpleado").value,
      tipoVinculacion: document.getElementById("tipoVinculacionEmpleado").value,
      fechaNacimiento: document.getElementById("fechaNacimientoEmpleado").value
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

// ---- Editar datos de perfil (modal) ----

const modalEditarBackdrop = document.getElementById("modalEditarBackdrop");
const editarDatosForm = document.getElementById("editarDatosForm");
const editarAlertBox = document.getElementById("editarAlertBox");

function abrirModalEditar(empleadoId) {
  const empleado = empleados.find((e) => e.id === empleadoId);
  if (!empleado) return;
  clearAlert(editarAlertBox);
  document.getElementById("editarUid").value = empleado.id;
  document.getElementById("editarCedula").value = empleado.cedula || "";
  document.getElementById("editarTelefono").value = empleado.telefono || "";
  document.getElementById("editarCargo").value = empleado.cargo || "";
  document.getElementById("editarArea").value = empleado.area || "";
  document.getElementById("editarFechaIngreso").value = empleado.fechaIngreso || "";
  document.getElementById("editarTipoVinculacion").value = empleado.tipoVinculacion || "";
  document.getElementById("editarFechaNacimiento").value = empleado.fechaNacimiento || "";
  poblarSelectsJefe();
  document.getElementById("editarJefe").value = empleado.jefeInmediatoUid || "";
  modalEditarBackdrop.classList.add("open");
}

editarDatosForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearAlert(editarAlertBox);
  const btn = document.getElementById("editarGuardarBtn");
  btn.disabled = true;
  try {
    const llamada = httpsCallable(functions, "actualizarDatosEmpleado");
    await llamada({
      uid: document.getElementById("editarUid").value,
      cedula: document.getElementById("editarCedula").value.trim(),
      telefono: document.getElementById("editarTelefono").value.trim(),
      cargo: document.getElementById("editarCargo").value.trim(),
      area: document.getElementById("editarArea").value,
      jefeInmediatoUid: document.getElementById("editarJefe").value,
      fechaIngreso: document.getElementById("editarFechaIngreso").value,
      tipoVinculacion: document.getElementById("editarTipoVinculacion").value,
      fechaNacimiento: document.getElementById("editarFechaNacimiento").value
    });
    modalEditarBackdrop.classList.remove("open");
  } catch (err) {
    showAlert(editarAlertBox, friendlyError(err), "error");
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("editarCancelarBtn").addEventListener("click", () => modalEditarBackdrop.classList.remove("open"));

// ---- Acciones de la tabla ----

tabla.addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;

  if (btn.dataset.editar) {
    abrirModalEditar(btn.dataset.editar);
    return;
  }

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

// ---- Plantilla / carga masiva desde Excel ----

const TIPOS_VINCULACION = {
  indefinido: "Indefinido",
  fijo: "Fijo",
  prestacion_servicios: "Prestación de servicios",
  aprendiz: "Aprendiz"
};
const COLUMNAS_EMPLEADOS = [
  "Nombre", "Correo", "Cédula", "Teléfono", "Cargo", "Área",
  "Jefe inmediato (correo)", "Fecha de ingreso", "Tipo de vinculación", "Fecha de nacimiento"
];
const bulkProgress = document.getElementById("bulkProgress");

// Acepta tanto la etiqueta visible ("Interventoría") como la clave interna
// ("interventoria") al leer el Excel — más tolerante que exigirle al usuario
// escribir la clave exacta. Valor no reconocido = "" (advertencia suave).
function resolverEnum(valor, mapaLabels) {
  const texto = String(valor || "").trim();
  if (!texto) return "";
  if (mapaLabels[texto]) return texto;
  const porLabel = Object.keys(mapaLabels).find((clave) => mapaLabels[clave].toLowerCase() === texto.toLowerCase());
  return porLabel || "";
}

document.getElementById("plantillaBtn").addEventListener("click", async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Empleados");
  ws.columns = COLUMNAS_EMPLEADOS.map((h) => ({ header: h, key: h }));
  estilizarEncabezado(ws);
  ws.addRow([
    "Juan Pérez", "juan.perez@correo.com", "1075123456", "3001234567",
    "Ingeniero de Interventoría", "Interventoría", "", "2024-03-01", "Indefinido", "1990-05-14"
  ]);
  ajustarAnchoColumnas(ws);
  await descargarWorkbook(wb, "plantilla_empleados.xlsx");
});

document.getElementById("cargarMasivoBtn").addEventListener("click", () => {
  document.getElementById("excelInput").click();
});

document.getElementById("excelInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;

  bulkProgress.classList.remove("hidden");
  bulkProgress.textContent = "Leyendo archivo...";

  try {
    const wb = await leerWorkbook(file);
    const ws = wb.worksheets[0];
    const enc = mapaEncabezados(ws);
    const col = {
      nombre: enc["nombre"],
      correo: enc["correo"],
      cedula: enc["cédula"] || enc["cedula"],
      telefono: enc["teléfono"] || enc["telefono"],
      cargo: enc["cargo"],
      area: enc["área"] || enc["area"],
      jefeCorreo: enc["jefe inmediato (correo)"],
      fechaIngreso: enc["fecha de ingreso"],
      tipoVinculacion: enc["tipo de vinculación"] || enc["tipo de vinculacion"],
      fechaNacimiento: enc["fecha de nacimiento"]
    };
    const filas = filasConDatos(ws);

    let invitadas = 0;
    const errores = [];
    for (let i = 0; i < filas.length; i++) {
      const { rowNumber, row } = filas[i];
      bulkProgress.textContent = `Cargando ${i + 1}/${filas.length}...`;

      const nombre = valorCelda(row, col.nombre);
      const correo = valorCelda(row, col.correo).toLowerCase();
      if (!nombre || !correo) {
        errores.push(`Fila ${rowNumber}: falta el nombre o el correo.`);
        continue;
      }

      const areaResuelta = resolverEnum(valorCelda(row, col.area), AREAS);
      if (valorCelda(row, col.area) && !areaResuelta) {
        errores.push(`Fila ${rowNumber}: área "${valorCelda(row, col.area)}" no reconocida, se dejó en blanco.`);
      }
      const tipoResuelto = resolverEnum(valorCelda(row, col.tipoVinculacion), TIPOS_VINCULACION);
      if (valorCelda(row, col.tipoVinculacion) && !tipoResuelto) {
        errores.push(`Fila ${rowNumber}: tipo de vinculación "${valorCelda(row, col.tipoVinculacion)}" no reconocido, se dejó en blanco.`);
      }
      const correoJefe = valorCelda(row, col.jefeCorreo).toLowerCase();
      let jefeInmediatoUid = "";
      if (correoJefe) {
        const jefe = empleados.find((emp) => (emp.correo || "").toLowerCase() === correoJefe);
        if (jefe) jefeInmediatoUid = jefe.id;
        else errores.push(`Fila ${rowNumber}: no se encontró un empleado con correo de jefe "${correoJefe}", se dejó en blanco.`);
      }

      try {
        await httpsCallable(functions, "invitarEmpleado")({
          nombre,
          correo,
          cedula: valorCelda(row, col.cedula),
          telefono: valorCelda(row, col.telefono),
          cargo: valorCelda(row, col.cargo),
          area: areaResuelta,
          jefeInmediatoUid,
          fechaIngreso: valorCelda(row, col.fechaIngreso),
          tipoVinculacion: tipoResuelto,
          fechaNacimiento: valorCelda(row, col.fechaNacimiento)
        });
        invitadas++;
      } catch (err) {
        errores.push(`Fila ${rowNumber}: ${friendlyError(err)}`);
      }
      await esperar(400);
    }

    bulkProgress.textContent = `Se invitaron ${invitadas} empleado(s).` + (errores.length ? ` ${errores.length} error(es): ${errores.join(" | ")}` : "");
  } catch (err) {
    bulkProgress.textContent = `No se pudo leer el archivo: ${err.message || err}`;
  }
});

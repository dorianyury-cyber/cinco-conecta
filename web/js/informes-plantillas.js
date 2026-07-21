import { collection, onSnapshot, query, orderBy } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js";
import { db, functions, requireAuth, wireLogoutButton, setActiveNav, showAlert, clearAlert, friendlyError, formatDate, obtenerArchivoComoDataUrl } from "./utils.js";

const { perfil } = await requireAuth();
wireLogoutButton();
setActiveNav();

const esAdmin = perfil.rol === "admin";
if (esAdmin) document.getElementById("subirCard").classList.remove("hidden");

function leerArchivoComoBase64(file) {
  return new Promise((resolve, reject) => {
    const lector = new FileReader();
    lector.onload = () => resolve(String(lector.result).split(",")[1] || "");
    lector.onerror = reject;
    lector.readAsDataURL(file);
  });
}

// ---------------------------------------------------------------------
// Plantillas
// ---------------------------------------------------------------------

const tablaPlantillas = document.getElementById("tablaPlantillas");
const plantillaSelect = document.getElementById("plantillaSelect");
const datalistClientes = document.getElementById("clientesConocidos");

let plantillas = [];

function renderPlantillas() {
  if (plantillas.length === 0) {
    tablaPlantillas.innerHTML = '<tr><td colspan="5" class="text-muted text-center">Aún no hay plantillas.</td></tr>';
  } else {
    tablaPlantillas.innerHTML = plantillas
      .map((p) => `
        <tr>
          <td><b>${p.nombre}</b></td>
          <td>${p.cliente}</td>
          <td>${(p.campos || []).filter((c) => c.activo !== false).length} de ${(p.campos || []).length}</td>
          <td>${p.creadoEn ? formatDate(p.creadoEn) : "-"}</td>
          <td>
            ${esAdmin ? `<button class="icon-btn" data-editar="${p.id}">✏️ Editar campos</button>` : ""}
            ${esAdmin ? `<button class="icon-btn danger" data-eliminar="${p.id}">🗑️ Eliminar</button>` : ""}
          </td>
        </tr>
      `)
      .join("");
  }

  const seleccionActual = plantillaSelect.value;
  plantillaSelect.innerHTML = '<option value="">Selecciona una plantilla...</option>' +
    plantillas.map((p) => `<option value="${p.id}">${p.nombre} — ${p.cliente}</option>`).join("");
  plantillaSelect.value = plantillas.some((p) => p.id === seleccionActual) ? seleccionActual : "";

  const clientesUnicos = [...new Set(plantillas.map((p) => p.cliente).filter(Boolean))];
  datalistClientes.innerHTML = clientesUnicos.map((c) => `<option value="${c}"></option>`).join("");
}

onSnapshot(query(collection(db, "plantillasInforme"), orderBy("creadoEn", "desc")), (snap) => {
  plantillas = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  renderPlantillas();
  actualizarFormularioCampos();
}, (err) => {
  tablaPlantillas.innerHTML = `<tr><td colspan="5" class="text-muted text-center">${friendlyError(err)}</td></tr>`;
});

if (esAdmin) {
  const form = document.getElementById("subirForm");
  const alertBox = document.getElementById("alertBox");
  const subirBtn = document.getElementById("subirBtn");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearAlert(alertBox);
    subirBtn.disabled = true;
    subirBtn.textContent = "Subiendo...";
    try {
      const archivo = document.getElementById("archivo").files[0];
      if (!archivo) throw new Error("Selecciona el archivo de la plantilla.");
      const llamada = httpsCallable(functions, "subirPlantilla");
      await llamada({
        nombre: document.getElementById("nombre").value,
        cliente: document.getElementById("cliente").value,
        archivoBase64: await leerArchivoComoBase64(archivo),
        archivoNombre: archivo.name,
        archivoTipo: archivo.type
      });
      showAlert(alertBox, "¡Plantilla subida! Ya puedes revisar los campos detectados en la lista de abajo.", "success");
      form.reset();
    } catch (err) {
      showAlert(alertBox, friendlyError(err), "error");
    } finally {
      subirBtn.disabled = false;
      subirBtn.textContent = "Subir y detectar campos";
    }
  });
}

// ---- Editar campos (modal) ----

const modalBackdrop = document.getElementById("modalBackdrop");
const camposEditor = document.getElementById("camposEditor");
const modalAlertBox = document.getElementById("modalAlertBox");
let plantillaEnEdicion = null;

function abrirModalCampos(plantilla) {
  plantillaEnEdicion = plantilla;
  clearAlert(modalAlertBox);
  camposEditor.innerHTML = (plantilla.campos || [])
    .map((c, i) => `
      <div class="item-card card">
        <label class="checkbox-row">
          <input type="checkbox" data-activo="${i}" ${c.activo !== false ? "checked" : ""}>
          Campo activo
        </label>
        <label>Etiqueta para «{${c.clave}}»</label>
        <input type="text" data-etiqueta="${i}" value="${(c.etiqueta || c.clave).replace(/"/g, "&quot;")}" maxlength="150">
      </div>
    `)
    .join("");
  modalBackdrop.classList.add("open");
}

document.getElementById("cerrarModalBtn").addEventListener("click", () => modalBackdrop.classList.remove("open"));

document.getElementById("guardarCamposBtn").addEventListener("click", async () => {
  if (!plantillaEnEdicion) return;
  const btn = document.getElementById("guardarCamposBtn");
  btn.disabled = true;
  btn.textContent = "Guardando...";
  try {
    const campos = (plantillaEnEdicion.campos || []).map((c, i) => ({
      clave: c.clave,
      etiqueta: document.querySelector(`[data-etiqueta="${i}"]`).value.trim() || c.clave,
      activo: document.querySelector(`[data-activo="${i}"]`).checked
    }));
    const llamada = httpsCallable(functions, "actualizarCamposPlantilla");
    await llamada({ plantillaId: plantillaEnEdicion.id, campos });
    modalBackdrop.classList.remove("open");
  } catch (err) {
    showAlert(modalAlertBox, friendlyError(err), "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Guardar cambios";
  }
});

tablaPlantillas.addEventListener("click", async (e) => {
  const editarId = e.target.dataset.editar;
  const eliminarId = e.target.dataset.eliminar;

  if (editarId) {
    const p = plantillas.find((x) => x.id === editarId);
    if (p) abrirModalCampos(p);
  }

  if (eliminarId) {
    if (!confirm("¿Eliminar esta plantilla? Los informes ya generados a partir de ella no se ven afectados.")) return;
    try {
      const llamada = httpsCallable(functions, "eliminarPlantilla");
      await llamada({ plantillaId: eliminarId });
    } catch (err) {
      alert(friendlyError(err));
    }
  }
});

// ---------------------------------------------------------------------
// Generar informe a partir de una plantilla
// ---------------------------------------------------------------------

const camposFormulario = document.getElementById("camposFormulario");
const generarBtn = document.getElementById("generarBtn");
const generarAlertBox = document.getElementById("generarAlertBox");

function actualizarFormularioCampos() {
  const plantilla = plantillas.find((p) => p.id === plantillaSelect.value);
  if (!plantilla) {
    camposFormulario.innerHTML = "";
    generarBtn.disabled = true;
    return;
  }
  const camposActivos = (plantilla.campos || []).filter((c) => c.activo !== false);
  camposFormulario.innerHTML = camposActivos
    .map((c) => `
      <label for="campo-${c.clave}">${c.etiqueta}</label>
      <textarea id="campo-${c.clave}" rows="2" data-clave="${c.clave}"></textarea>
    `)
    .join("");
  generarBtn.disabled = camposActivos.length === 0;
}

plantillaSelect.addEventListener("change", actualizarFormularioCampos);

generarBtn.addEventListener("click", async () => {
  const plantilla = plantillas.find((p) => p.id === plantillaSelect.value);
  if (!plantilla) return;
  clearAlert(generarAlertBox);
  generarBtn.disabled = true;
  generarBtn.textContent = "Generando...";
  try {
    const valores = {};
    camposFormulario.querySelectorAll("[data-clave]").forEach((el) => {
      valores[el.dataset.clave] = el.value;
    });
    const llamada = httpsCallable(functions, "generarInformePlantilla");
    await llamada({ plantillaId: plantilla.id, valores });
    showAlert(generarAlertBox, "¡Informe generado! Lo encuentras en la lista de abajo.", "success");
    plantillaSelect.value = "";
    actualizarFormularioCampos();
  } catch (err) {
    showAlert(generarAlertBox, friendlyError(err), "error");
  } finally {
    generarBtn.disabled = false;
    generarBtn.textContent = "Generar informe";
  }
});

// ---------------------------------------------------------------------
// Informes ya generados
// ---------------------------------------------------------------------

const tablaInformes = document.getElementById("tablaInformesPlantilla");
let informesGenerados = [];

function renderInformesGenerados() {
  if (informesGenerados.length === 0) {
    tablaInformes.innerHTML = '<tr><td colspan="5" class="text-muted text-center">Aún no hay informes generados.</td></tr>';
    return;
  }
  tablaInformes.innerHTML = informesGenerados
    .map((i) => `
      <tr>
        <td>${i.codigo || "-"}</td>
        <td><b>${i.plantillaNombre || "-"}</b></td>
        <td>${i.cliente || "-"}</td>
        <td>${i.creadoEn ? formatDate(i.creadoEn) : "-"} · ${i.generadoPorNombre || ""}</td>
        <td><button class="icon-btn" data-descargar="${i.id}">⬇️ Descargar</button></td>
      </tr>
    `)
    .join("");
}

onSnapshot(query(collection(db, "informesPlantilla"), orderBy("creadoEn", "desc")), (snap) => {
  informesGenerados = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  renderInformesGenerados();
}, (err) => {
  tablaInformes.innerHTML = `<tr><td colspan="5" class="text-muted text-center">${friendlyError(err)}</td></tr>`;
});

tablaInformes.addEventListener("click", async (e) => {
  const id = e.target.dataset.descargar;
  if (!id) return;
  const informe = informesGenerados.find((i) => i.id === id);
  e.target.disabled = true;
  const textoOriginal = e.target.textContent;
  e.target.textContent = "Descargando...";
  try {
    const dataUrl = await obtenerArchivoComoDataUrl(informe.archivoGenerado.path);
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = informe.archivoGenerado.nombre || "informe.docx";
    a.click();
  } catch (err) {
    alert(friendlyError(err));
  } finally {
    e.target.disabled = false;
    e.target.textContent = textoOriginal;
  }
});

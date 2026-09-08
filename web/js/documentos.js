import { collection, onSnapshot, query, orderBy } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js";
import { db, functions, requireAuth, wireLogoutButton, setActiveNav, showAlert, clearAlert, friendlyError, formatDate, obtenerArchivoComoDataUrl, tienePermiso } from "./utils.js";

const { perfil } = await requireAuth();
wireLogoutButton();
setActiveNav();

const esAdmin = tienePermiso(perfil, "documentos");
if (esAdmin) document.getElementById("subirCard").classList.remove("hidden");

const tabla = document.getElementById("tablaDocumentos");
const filtroCategoria = document.getElementById("filtroCategoria");
const CATEGORIA_TEXTO = { procedimiento: "Procedimiento", instructivo: "Instructivo", formato: "Formato" };

let documentos = [];

function documentosFiltrados() {
  const categoria = filtroCategoria.value;
  return categoria ? documentos.filter((d) => d.categoria === categoria) : documentos;
}

function celdaTrunc(texto, anchoPx) {
  return `<span class="celda-trunc" style="max-width:${anchoPx}px;" title="${(texto || "").replace(/"/g, "&quot;")}">${texto || "-"}</span>`;
}

// Fila = solo lo justo para escanear y elegir; el detalle (con el botón de
// descarga) vive en el panel de vista previa de arriba — mismo patrón que
// Empleados/Vacantes (ver empleados.js).
function render() {
  const filtrados = documentosFiltrados();
  if (filtrados.length === 0) {
    tabla.innerHTML = `<tr><td colspan="4" class="text-muted text-center">${documentos.length === 0 ? "Aún no hay documentos." : "Ningún documento coincide con el filtro."}</td></tr>`;
    documentoSeleccionadoId = null;
    pintarVistaPreviaDocumento();
    return;
  }
  if (!documentoSeleccionadoId || !filtrados.some((d) => d.id === documentoSeleccionadoId)) {
    documentoSeleccionadoId = filtrados[0].id;
  }
  tabla.innerHTML = filtrados.map((d) => `
    <tr data-id="${d.id}">
      <td style="font-weight:600;">${celdaTrunc(d.titulo, 320)}</td>
      <td>${CATEGORIA_TEXTO[d.categoria] || d.categoria}</td>
      <td>${d.version || "-"}</td>
      <td>${celdaTrunc(`${d.creadoEn ? formatDate(d.creadoEn) : "-"} · ${d.subidoPorNombre || ""}`, 220)}</td>
    </tr>
  `).join("");
  tabla.querySelectorAll("tr[data-id]").forEach((tr) => {
    tr.addEventListener("click", () => {
      documentoSeleccionadoId = tr.getAttribute("data-id");
      actualizarResaltadoDocumento();
      pintarVistaPreviaDocumento();
    });
  });
  actualizarResaltadoDocumento();
  pintarVistaPreviaDocumento();
}

let documentoSeleccionadoId = null;

function actualizarResaltadoDocumento() {
  tabla.querySelectorAll("tr[data-id]").forEach((tr) => {
    tr.classList.toggle("fila-fijada", tr.getAttribute("data-id") === documentoSeleccionadoId);
  });
}

function escapeHtml(texto) {
  return String(texto ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const vistaPreviaEl = document.getElementById("vistaPreviaDocumento");
const VISTA_PREVIA_VACIA = '<p class="text-muted" style="margin:0;">Aún no hay documentos.</p>';

async function descargarDocumento(d, btn) {
  btn.disabled = true;
  const textoOriginal = btn.textContent;
  btn.textContent = "Descargando...";
  try {
    const dataUrl = await obtenerArchivoComoDataUrl(d.archivo.path);
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = d.archivo.nombre || "documento";
    a.click();
  } catch (err) {
    alert(friendlyError(err));
  } finally {
    btn.disabled = false;
    btn.textContent = textoOriginal;
  }
}

function pintarVistaPreviaDocumento() {
  if (!vistaPreviaEl) return;
  const d = documentos.find((x) => x.id === documentoSeleccionadoId);
  if (!d) { vistaPreviaEl.innerHTML = VISTA_PREVIA_VACIA; return; }

  const campo = (etiqueta, valor) => `
    <div class="vp-campo">
      <span class="vp-etiqueta">${etiqueta}</span>
      <span class="vp-valor">${escapeHtml(valor || "-")}</span>
    </div>`;

  vistaPreviaEl.innerHTML = `
    <div class="vp-encabezado">
      <span class="vp-nombre">${escapeHtml(d.titulo)}</span>
      <div class="vp-acciones">
        <button class="icon-btn" data-descargar="${d.id}">⬇️ Descargar</button>
      </div>
    </div>
    <div class="vp-grupos">
      <div class="vp-grupo">
        <div class="vp-grupo-titulo">Documento</div>
        <div class="vp-grupo-campos">
          ${campo("Categoría", CATEGORIA_TEXTO[d.categoria] || d.categoria)}
          ${campo("Versión", d.version)}
          ${campo("Subido el", d.creadoEn ? formatDate(d.creadoEn) : "")}
          ${campo("Subido por", d.subidoPorNombre)}
          ${campo("Archivo", d.archivo?.nombre)}
        </div>
      </div>
    </div>
  `;

  vistaPreviaEl.querySelector("[data-descargar]")?.addEventListener("click", (e) => descargarDocumento(d, e.currentTarget));
}

onSnapshot(query(collection(db, "documentos"), orderBy("creadoEn", "desc")), (snap) => {
  documentos = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  render();
}, (err) => {
  tabla.innerHTML = `<tr><td colspan="4" class="text-muted text-center">${friendlyError(err)}</td></tr>`;
});

filtroCategoria.addEventListener("change", render);

function leerArchivoComoBase64(file) {
  return new Promise((resolve, reject) => {
    const lector = new FileReader();
    lector.onload = () => resolve(String(lector.result).split(",")[1] || "");
    lector.onerror = reject;
    lector.readAsDataURL(file);
  });
}

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
      if (!archivo) throw new Error("Selecciona un archivo.");
      const llamada = httpsCallable(functions, "subirDocumento");
      await llamada({
        titulo: document.getElementById("titulo").value,
        categoria: document.getElementById("categoria").value,
        version: document.getElementById("version").value,
        archivoBase64: await leerArchivoComoBase64(archivo),
        archivoNombre: archivo.name,
        archivoTipo: archivo.type
      });
      showAlert(alertBox, "¡Documento subido!", "success");
      form.reset();
    } catch (err) {
      showAlert(alertBox, friendlyError(err), "error");
    } finally {
      subirBtn.disabled = false;
      subirBtn.textContent = "Subir";
    }
  });
}

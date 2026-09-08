import { collection, onSnapshot, updateDoc, doc, query, orderBy } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js";
import { db, functions, requireAuth, wireLogoutButton, setActiveNav, showAlert, clearAlert, friendlyError, formatDate, formatDateCorta, tienePermiso, obtenerArchivoComoDataUrl } from "./utils.js";
import { crearDocumentoPDF, agregarEncabezado, agregarTabla, agregarPiePagina, descargarPDF } from "./pdf.js";

const { perfil } = await requireAuth();
wireLogoutButton();
setActiveNav();

const esAdmin = tienePermiso(perfil, "incidentes");
const form = document.getElementById("incidenteForm");
const alertBox = document.getElementById("alertBox");
const reportarBtn = document.getElementById("reportarBtn");
const tabla = document.getElementById("tablaIncidentes");

const TIPO_TEXTO = { incidente: "Incidente", casi_accidente: "Casi-accidente" };
const GRAVEDAD_TEXTO = { leve: "Leve", moderada: "Moderada", grave: "Grave" };
const GRAVEDAD_BADGE = { leve: "ok", moderada: "warn", grave: "danger" };

let incidentes = [];

function celdaTrunc(texto, anchoPx) {
  return `<span class="celda-trunc" style="max-width:${anchoPx}px;" title="${(texto || "").replace(/"/g, "&quot;")}">${texto || "-"}</span>`;
}
function escapeHtml(texto) {
  return String(texto ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Fila = solo lo justo para escanear y elegir; el detalle (descripción,
// foto, acciones) vive en el panel de vista previa de arriba — mismo
// patrón que Empleados/Vacantes/Documentos (ver empleados.js).
function render() {
  if (incidentes.length === 0) {
    tabla.innerHTML = '<tr><td colspan="6" class="text-muted text-center">Aún no hay incidentes reportados.</td></tr>';
    incidenteSeleccionadoId = null;
    pintarVistaPreviaIncidente();
    return;
  }
  if (!incidenteSeleccionadoId || !incidentes.some((i) => i.id === incidenteSeleccionadoId)) {
    incidenteSeleccionadoId = incidentes[0].id;
  }
  tabla.innerHTML = incidentes.map((i) => `
    <tr data-id="${i.id}">
      <td>${TIPO_TEXTO[i.tipo] || i.tipo}</td>
      <td style="font-weight:600;">${celdaTrunc(i.titulo, 260)}</td>
      <td>${celdaTrunc(i.lugar, 140)}</td>
      <td>${formatDate(i.fecha)}</td>
      <td><span class="badge ${GRAVEDAD_BADGE[i.gravedad] || "muted"}">${GRAVEDAD_TEXTO[i.gravedad] || i.gravedad}</span></td>
      <td><span class="badge ${i.estado === "abierto" ? "warn" : "ok"}">${i.estado === "abierto" ? "Abierto" : "Cerrado"}</span></td>
    </tr>
  `).join("");
  tabla.querySelectorAll("tr[data-id]").forEach((tr) => {
    tr.addEventListener("click", () => {
      incidenteSeleccionadoId = tr.getAttribute("data-id");
      actualizarResaltadoIncidente();
      pintarVistaPreviaIncidente();
    });
  });
  actualizarResaltadoIncidente();
  pintarVistaPreviaIncidente();
}

let incidenteSeleccionadoId = null;

function actualizarResaltadoIncidente() {
  tabla.querySelectorAll("tr[data-id]").forEach((tr) => {
    tr.classList.toggle("fila-fijada", tr.getAttribute("data-id") === incidenteSeleccionadoId);
  });
}

const vistaPreviaEl = document.getElementById("vistaPreviaIncidente");
const VISTA_PREVIA_VACIA = '<p class="text-muted" style="margin:0;">Aún no hay incidentes reportados.</p>';

function pintarVistaPreviaIncidente() {
  if (!vistaPreviaEl) return;
  const i = incidentes.find((x) => x.id === incidenteSeleccionadoId);
  if (!i) { vistaPreviaEl.innerHTML = VISTA_PREVIA_VACIA; return; }

  const campo = (etiqueta, valor) => `
    <div class="vp-campo">
      <span class="vp-etiqueta">${etiqueta}</span>
      <span class="vp-valor">${escapeHtml(valor || "-")}</span>
    </div>`;

  const acciones = [];
  if (i.foto) acciones.push(`<button class="icon-btn" data-ver-foto="${i.id}">🖼️ Ver foto</button>`);
  if (esAdmin && i.estado === "abierto") acciones.push(`<button class="icon-btn" data-cerrar="${i.id}">✅ Marcar como cerrado</button>`);
  if (esAdmin) acciones.push(`<a class="icon-btn" href="acciones-correctivas.html?origenTipo=incidente&origenId=${i.id}&origenTitulo=${encodeURIComponent(i.titulo)}">➕ Crear acción correctiva</a>`);

  vistaPreviaEl.innerHTML = `
    <div class="vp-encabezado">
      <span class="vp-nombre">${escapeHtml(i.titulo)}</span>
      <div class="vp-acciones">${acciones.join("")}</div>
    </div>
    <div class="vp-grupos">
      <div class="vp-grupo">
        <div class="vp-grupo-titulo">Detalle</div>
        <div class="vp-grupo-campos">
          ${campo("Tipo", TIPO_TEXTO[i.tipo] || i.tipo)}
          ${campo("Lugar", i.lugar)}
          ${campo("Fecha", formatDate(i.fecha))}
          ${campo("Gravedad", GRAVEDAD_TEXTO[i.gravedad] || i.gravedad)}
          ${campo("Estado", i.estado === "abierto" ? "Abierto" : "Cerrado")}
          ${campo("Reportado por", i.reportadoPorNombre)}
        </div>
      </div>
      <div class="vp-grupo">
        <div class="vp-grupo-titulo">Descripción</div>
        <div class="vp-grupo-campos">${campo("Descripción", i.descripcion)}</div>
      </div>
    </div>
    <div id="fotoIncidenteWrap"></div>
  `;

  vistaPreviaEl.querySelector("[data-cerrar]")?.addEventListener("click", async () => {
    await updateDoc(doc(db, "incidentes", i.id), { estado: "cerrado" });
  });
  vistaPreviaEl.querySelector("[data-ver-foto]")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const textoOriginal = btn.textContent;
    btn.textContent = "Cargando...";
    try {
      const dataUrl = await obtenerArchivoComoDataUrl(i.foto.path);
      document.getElementById("fotoIncidenteWrap").innerHTML = `<img src="${dataUrl}" alt="Foto del incidente" style="max-width:100%;border-radius:8px;margin-top:10px;">`;
    } catch (err) {
      alert(friendlyError(err));
    } finally {
      btn.disabled = false;
      btn.textContent = textoOriginal;
    }
  });
}

onSnapshot(query(collection(db, "incidentes"), orderBy("creadoEn", "desc")), (snap) => {
  incidentes = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  render();
}, (err) => {
  tabla.innerHTML = `<tr><td colspan="6" class="text-muted text-center">${friendlyError(err)}</td></tr>`;
});

function leerArchivoComoBase64(file) {
  return new Promise((resolve, reject) => {
    const lector = new FileReader();
    lector.onload = () => resolve(String(lector.result).split(",")[1] || "");
    lector.onerror = reject;
    lector.readAsDataURL(file);
  });
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearAlert(alertBox);
  reportarBtn.disabled = true;
  reportarBtn.textContent = "Enviando...";

  try {
    const archivo = document.getElementById("foto").files[0];
    const datos = {
      tipo: document.getElementById("tipo").value,
      titulo: document.getElementById("titulo").value,
      lugar: document.getElementById("lugar").value,
      fecha: document.getElementById("fecha").value,
      gravedad: document.getElementById("gravedad").value,
      descripcion: document.getElementById("descripcion").value
    };
    if (archivo) {
      datos.fotoBase64 = await leerArchivoComoBase64(archivo);
      datos.fotoTipo = archivo.type;
    }
    const llamada = httpsCallable(functions, "reportarIncidente");
    await llamada(datos);
    showAlert(alertBox, "¡Reporte enviado!", "success");
    form.reset();
  } catch (err) {
    showAlert(alertBox, friendlyError(err), "error");
  } finally {
    reportarBtn.disabled = false;
    reportarBtn.textContent = "Reportar";
  }
});

document.getElementById("generarInformeBtn").addEventListener("click", () => {
  const columnas = ["Tipo", "Título", "Lugar", "Fecha", "Gravedad", "Estado", "Reportado por"];
  const filas = incidentes.map((i) => [
    TIPO_TEXTO[i.tipo] || i.tipo,
    i.titulo,
    i.lugar,
    formatDateCorta(i.fecha),
    i.gravedad,
    i.estado === "abierto" ? "Abierto" : "Cerrado",
    i.reportadoPorNombre
  ]);
  const docPdf = crearDocumentoPDF();
  const startY = agregarEncabezado(docPdf, "Cinco S.A.S.", "Informe de Incidentes y Casi-accidentes", "Sistema SGI-HSEQ — Cinco Conecta");
  const filaVacia = ["-", "Sin incidentes registrados.", "-", "-", "-", "-", "-"];
  agregarTabla(docPdf, columnas, filas.length ? filas : [filaVacia], startY);
  agregarPiePagina(docPdf);
  descargarPDF(docPdf, "incidentes.pdf");
});

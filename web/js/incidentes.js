import { collection, onSnapshot, updateDoc, doc, query, orderBy } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js";
import { db, functions, requireAuth, wireLogoutButton, setActiveNav, showAlert, clearAlert, friendlyError, formatDate, formatDateCorta } from "./utils.js";
import { crearDocumentoPDF, agregarEncabezado, agregarTabla, agregarPiePagina, descargarPDF } from "./pdf.js";

const { perfil } = await requireAuth();
wireLogoutButton();
setActiveNav();

const esAdmin = perfil.rol === "admin";
const form = document.getElementById("incidenteForm");
const alertBox = document.getElementById("alertBox");
const reportarBtn = document.getElementById("reportarBtn");
const lista = document.getElementById("listaIncidentes");

const TIPO_TEXTO = { incidente: "Incidente", casi_accidente: "Casi-accidente" };
const GRAVEDAD_BADGE = { leve: "ok", moderada: "warn", grave: "danger" };

let incidentes = [];

function render() {
  if (incidentes.length === 0) {
    lista.innerHTML = '<p class="text-muted text-center">Aún no hay incidentes reportados.</p>';
    return;
  }
  lista.innerHTML = incidentes
    .map((i) => `
      <div class="card">
        <p>
          <span class="badge ${GRAVEDAD_BADGE[i.gravedad] || "muted"}">${i.gravedad}</span>
          <span class="badge ${i.estado === "abierto" ? "warn" : "ok"}">${i.estado === "abierto" ? "Abierto" : "Cerrado"}</span>
          <strong>${TIPO_TEXTO[i.tipo] || i.tipo}</strong> — ${i.titulo}
        </p>
        <p class="text-muted text-sm">${i.lugar} · ${formatDate(i.fecha)} · Reportado por ${i.reportadoPorNombre}</p>
        <p>${i.descripcion}</p>
        ${esAdmin ? `
          <div class="toolbar">
            ${i.estado === "abierto" ? `<button class="icon-btn" data-cerrar="${i.id}">Marcar como cerrado</button>` : ""}
            <a class="icon-btn" href="acciones-correctivas.html?origenTipo=incidente&origenId=${i.id}&origenTitulo=${encodeURIComponent(i.titulo)}">+ Crear acción correctiva</a>
          </div>
        ` : ""}
      </div>
    `)
    .join("");
}

onSnapshot(query(collection(db, "incidentes"), orderBy("creadoEn", "desc")), (snap) => {
  incidentes = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  render();
}, (err) => {
  lista.innerHTML = `<p class="text-muted text-center">${friendlyError(err)}</p>`;
});

lista.addEventListener("click", async (e) => {
  const id = e.target.dataset.cerrar;
  if (!id) return;
  await updateDoc(doc(db, "incidentes", id), { estado: "cerrado" });
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

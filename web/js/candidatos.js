import { collection, onSnapshot, doc, updateDoc, arrayUnion, Timestamp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import {
  db, requireAuth, wireLogoutButton, setActiveNav, showAlert, clearAlert, friendlyError, formatDateCorta, obtenerArchivoComoDataUrl
} from "./utils.js";
import { ExcelJS, descargarWorkbook, estilizarEncabezado } from "./excel.js";
import { crearDocumentoPDF, agregarEncabezado, agregarTabla, agregarPiePagina, descargarPDF } from "./pdf.js";

await requireAuth();
wireLogoutButton();
setActiveNav();

const ETAPAS = [
  { valor: "recibido", label: "Recibido" },
  { valor: "preseleccionado", label: "Preseleccionado" },
  { valor: "entrevista", label: "Entrevista" },
  { valor: "prueba", label: "Prueba" },
  { valor: "oferta", label: "Oferta" },
  { valor: "contratado", label: "Contratado" },
  { valor: "rechazado", label: "Rechazado" }
];

const kanban = document.getElementById("kanban");
const filtroVacante = document.getElementById("filtroVacante");
const modalBackdrop = document.getElementById("modalBackdrop");
const modalAlert = document.getElementById("modalAlert");

let candidatos = [];
let vacantes = [];
let candidatoActualId = null;

onSnapshot(collection(db, "vacantes"), (snap) => {
  vacantes = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const seleccionActual = filtroVacante.value;
  filtroVacante.innerHTML = '<option value="">Todas las vacantes</option>'
    + vacantes.map((v) => `<option value="${v.id}">${v.titulo}</option>`).join("");
  filtroVacante.value = seleccionActual;
});

function candidatosFiltrados() {
  const vacanteId = filtroVacante.value;
  return candidatos.filter((c) => !vacanteId || c.vacanteId === vacanteId);
}

function render() {
  const filtrados = candidatosFiltrados();
  kanban.innerHTML = ETAPAS.map((etapa) => {
    const deEstaEtapa = filtrados.filter((c) => c.etapa === etapa.valor);
    return `
      <div class="kanban-col">
        <h3>${etapa.label} <span>${deEstaEtapa.length}</span></h3>
        ${deEstaEtapa.map((c) => `
          <div class="candidato-card" data-id="${c.id}">
            <div class="nombre">${c.nombres} ${c.apellidos}</div>
            <div class="vacante">${c.vacanteTitulo || ""}</div>
          </div>
        `).join("") || '<p class="text-muted text-xs">Sin candidatos</p>'}
      </div>
    `;
  }).join("");
}

onSnapshot(collection(db, "candidatos"), (snap) => {
  candidatos = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  render();
}, (err) => {
  kanban.innerHTML = `<p class="text-muted">${friendlyError(err)}</p>`;
});

filtroVacante.addEventListener("change", render);

async function abrirModal(candidatoId) {
  const c = candidatos.find((x) => x.id === candidatoId);
  if (!c) return;
  candidatoActualId = candidatoId;
  clearAlert(modalAlert);

  document.getElementById("modalNombre").textContent = `${c.nombres} ${c.apellidos}`;
  document.getElementById("modalVacante").textContent = c.vacanteTitulo || "";
  document.getElementById("modalContacto").textContent = `${c.email} · ${c.telefono} · Cédula ${c.cedula}`;
  document.getElementById("modalEtapa").value = c.etapa;
  document.getElementById("modalNotas").value = c.notas || "";

  const enlaceHojaVida = document.getElementById("modalHojaVida");
  enlaceHojaVida.textContent = "Cargando enlace...";
  enlaceHojaVida.removeAttribute("href");

  modalBackdrop.classList.add("open");

  if (c.hojaVida?.path) {
    try {
      const dataUrl = await obtenerArchivoComoDataUrl(c.hojaVida.path);
      enlaceHojaVida.href = dataUrl;
      enlaceHojaVida.download = c.hojaVida.nombre || "hoja-de-vida";
      enlaceHojaVida.textContent = `Descargar: ${c.hojaVida.nombre || "hoja-de-vida"}`;
    } catch (err) {
      enlaceHojaVida.textContent = `No se pudo cargar (${friendlyError(err)})`;
    }
  } else {
    enlaceHojaVida.textContent = "No hay hoja de vida adjunta.";
  }
}

kanban.addEventListener("click", (e) => {
  const tarjeta = e.target.closest(".candidato-card");
  if (tarjeta) abrirModal(tarjeta.dataset.id);
});

document.getElementById("cerrarModalBtn").addEventListener("click", () => modalBackdrop.classList.remove("open"));

document.getElementById("guardarCandidatoBtn").addEventListener("click", async () => {
  if (!candidatoActualId) return;
  const btn = document.getElementById("guardarCandidatoBtn");
  clearAlert(modalAlert);
  btn.disabled = true;
  btn.textContent = "Guardando...";

  try {
    const c = candidatos.find((x) => x.id === candidatoActualId);
    const nuevaEtapa = document.getElementById("modalEtapa").value;
    const datos = { notas: document.getElementById("modalNotas").value.trim() };
    if (nuevaEtapa !== c.etapa) {
      datos.etapa = nuevaEtapa;
      datos.historialEtapas = arrayUnion({ etapa: nuevaEtapa, fecha: Timestamp.now() });
    }
    await updateDoc(doc(db, "candidatos", candidatoActualId), datos);
    modalBackdrop.classList.remove("open");
  } catch (err) {
    showAlert(modalAlert, friendlyError(err), "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Guardar";
  }
});

// ---- Exportar a Excel ----
document.getElementById("exportarBtn").addEventListener("click", async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Candidatos");
  ws.columns = [
    { header: "Vacante", key: "vacante", width: 26 },
    { header: "Nombres", key: "nombres", width: 20 },
    { header: "Apellidos", key: "apellidos", width: 20 },
    { header: "Email", key: "email", width: 26 },
    { header: "Teléfono", key: "telefono", width: 16 },
    { header: "Cédula", key: "cedula", width: 16 },
    { header: "Etapa", key: "etapa", width: 18 },
    { header: "Fecha postulación", key: "fecha", width: 18 }
  ];
  estilizarEncabezado(ws);
  candidatosFiltrados().forEach((c) => {
    ws.addRow({
      vacante: c.vacanteTitulo,
      nombres: c.nombres,
      apellidos: c.apellidos,
      email: c.email,
      telefono: c.telefono,
      cedula: c.cedula,
      etapa: ETAPAS.find((e) => e.valor === c.etapa)?.label || c.etapa,
      fecha: c.creadoEn ? formatDateCorta(c.creadoEn) : "-"
    });
  });
  await descargarWorkbook(wb, "candidatos.xlsx");
});

// ---- Informe PDF ----
document.getElementById("generarInformeBtn").addEventListener("click", () => {
  const columnas = ["Vacante", "Nombres", "Apellidos", "Email", "Teléfono", "Etapa", "Fecha"];
  const filas = candidatosFiltrados().map((c) => [
    c.vacanteTitulo || "-",
    c.nombres,
    c.apellidos,
    c.email,
    c.telefono,
    ETAPAS.find((e) => e.valor === c.etapa)?.label || c.etapa,
    c.creadoEn ? formatDateCorta(c.creadoEn) : "-"
  ]);

  const docPdf = crearDocumentoPDF();
  const startY = agregarEncabezado(docPdf, "Cinco S.A.S.", "Informe de Candidatos — Trabaja con Nosotros", "Cinco Conecta");
  const filaVacia = ["-", "Sin candidatos que coincidan con el filtro.", "-", "-", "-", "-", "-"];
  agregarTabla(docPdf, columnas, filas.length ? filas : [filaVacia], startY);
  agregarPiePagina(docPdf);
  descargarPDF(docPdf, "candidatos.pdf");
});

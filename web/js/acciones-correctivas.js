import { collection, onSnapshot, addDoc, updateDoc, doc, serverTimestamp, Timestamp, query, orderBy } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { db, requireAuth, wireLogoutButton, setActiveNav, showAlert, clearAlert, friendlyError, formatDate } from "./utils.js";
import { ExcelJS, descargarWorkbook, estilizarEncabezado } from "./excel.js";

const { user, perfil } = await requireAuth();
wireLogoutButton();
setActiveNav();

const esAdmin = perfil.rol === "admin";
const params = new URLSearchParams(window.location.search);
const origen = params.get("origenId")
  ? { tipo: params.get("origenTipo") || "manual", refId: params.get("origenId") }
  : { tipo: "manual", refId: null };

if (esAdmin) {
  document.getElementById("crearCard").classList.remove("hidden");
  if (params.get("origenTitulo")) {
    document.getElementById("origenTexto").textContent = `Originada en: ${params.get("origenTitulo")}`;
  }
}

const responsableSelect = document.getElementById("responsableUid");
let compañeros = [];
onSnapshot(collection(db, "staff"), (snap) => {
  compañeros = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((p) => p.estado === "activo");
  responsableSelect.innerHTML = compañeros.map((p) => `<option value="${p.id}">${p.nombre}</option>`).join("");
});

const ESTADO_BADGE = { abierta: "warn", en_progreso: "gold", cerrada: "ok" };
const ESTADO_TEXTO = { abierta: "Abierta", en_progreso: "En progreso", cerrada: "Cerrada" };

let acciones = [];
function render() {
  const visibles = esAdmin ? acciones : acciones.filter((a) => a.responsableUid === user.uid);
  if (visibles.length === 0) {
    document.getElementById("listaAcciones").innerHTML = '<p class="text-muted text-center">No hay acciones correctivas para mostrar.</p>';
    return;
  }
  document.getElementById("listaAcciones").innerHTML = visibles
    .map((a) => {
      const puedeEditar = esAdmin || a.responsableUid === user.uid;
      return `
        <div class="card">
          <p><span class="badge ${ESTADO_BADGE[a.estado]}">${ESTADO_TEXTO[a.estado]}</span> <strong>${a.responsableNombre}</strong> · vence ${formatDate(a.fechaLimite)}</p>
          <p>${a.descripcion}</p>
          ${puedeEditar ? `
            <label>Estado</label>
            <select data-estado="${a.id}" ${esAdmin ? "" : ""}>
              <option value="abierta" ${a.estado === "abierta" ? "selected" : ""}>Abierta</option>
              <option value="en_progreso" ${a.estado === "en_progreso" ? "selected" : ""}>En progreso</option>
              <option value="cerrada" ${a.estado === "cerrada" ? "selected" : ""}>Cerrada</option>
            </select>
            <label>Evidencia</label>
            <textarea rows="2" data-evidencia="${a.id}">${a.evidencia || ""}</textarea>
            <button type="button" class="btn secondary btn-auto" data-guardar="${a.id}">Guardar avance</button>
          ` : ""}
        </div>
      `;
    })
    .join("");
}

onSnapshot(query(collection(db, "accionesCorrectivas"), orderBy("creadoEn", "desc")), (snap) => {
  acciones = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  render();
}, (err) => {
  document.getElementById("listaAcciones").innerHTML = `<p class="text-muted text-center">${friendlyError(err)}</p>`;
});

document.getElementById("listaAcciones").addEventListener("click", async (e) => {
  const id = e.target.dataset.guardar;
  if (!id) return;
  const estado = document.querySelector(`[data-estado="${id}"]`).value;
  const evidencia = document.querySelector(`[data-evidencia="${id}"]`).value.trim();
  try {
    await updateDoc(doc(db, "accionesCorrectivas", id), { estado, evidencia });
  } catch (err) {
    alert(friendlyError(err));
  }
});

if (esAdmin) {
  document.getElementById("crearForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const alertBox = document.getElementById("crearAlertBox");
    const btn = document.getElementById("crearBtn");
    clearAlert(alertBox);
    btn.disabled = true;
    btn.textContent = "Creando...";
    try {
      const responsableUid = responsableSelect.value;
      const responsableNombre = compañeros.find((p) => p.id === responsableUid)?.nombre || "";
      await addDoc(collection(db, "accionesCorrectivas"), {
        descripcion: document.getElementById("descripcion").value.trim(),
        origen,
        responsableUid,
        responsableNombre,
        fechaLimite: document.getElementById("fechaLimite").value,
        estado: "abierta",
        evidencia: "",
        creadoEn: serverTimestamp(),
        cerradaEn: null
      });
      e.target.reset();
    } catch (err) {
      showAlert(alertBox, friendlyError(err), "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Crear";
    }
  });
}

document.getElementById("exportarBtn").addEventListener("click", async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Acciones Correctivas");
  ws.columns = [
    { header: "Descripción", key: "descripcion", width: 40 },
    { header: "Responsable", key: "responsable", width: 22 },
    { header: "Fecha límite", key: "fecha", width: 16 },
    { header: "Estado", key: "estado", width: 16 },
    { header: "Evidencia", key: "evidencia", width: 40 }
  ];
  estilizarEncabezado(ws);
  const visibles = esAdmin ? acciones : acciones.filter((a) => a.responsableUid === user.uid);
  visibles.forEach((a) => {
    const row = ws.addRow({
      descripcion: a.descripcion,
      responsable: a.responsableNombre,
      fecha: a.fechaLimite,
      estado: ESTADO_TEXTO[a.estado],
      evidencia: a.evidencia || ""
    });
    row.getCell(1).alignment = { wrapText: true, vertical: "top" };
    row.getCell(5).alignment = { wrapText: true, vertical: "top" };
  });
  await descargarWorkbook(wb, "acciones-correctivas.xlsx");
});

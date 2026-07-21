import { collection, onSnapshot, query, orderBy } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js";
import { db, functions, requireAuth, wireLogoutButton, setActiveNav, showAlert, clearAlert, friendlyError, formatDate, obtenerArchivoComoDataUrl } from "./utils.js";

const { perfil } = await requireAuth();
wireLogoutButton();
setActiveNav();

const esAdmin = perfil.rol === "admin";
if (esAdmin) document.getElementById("subirCard").classList.remove("hidden");

const tabla = document.getElementById("tablaDocumentos");
const CATEGORIA_TEXTO = { procedimiento: "Procedimiento", instructivo: "Instructivo", formato: "Formato" };

let documentos = [];
function render() {
  if (documentos.length === 0) {
    tabla.innerHTML = '<tr><td colspan="5" class="text-muted text-center">Aún no hay documentos.</td></tr>';
    return;
  }
  tabla.innerHTML = documentos
    .map((d) => `
      <tr>
        <td><b>${d.titulo}</b></td>
        <td>${CATEGORIA_TEXTO[d.categoria] || d.categoria}</td>
        <td>${d.version || "-"}</td>
        <td>${d.creadoEn ? formatDate(d.creadoEn) : "-"} · ${d.subidoPorNombre || ""}</td>
        <td><button class="icon-btn" data-descargar="${d.id}">⬇️ Descargar</button></td>
      </tr>
    `)
    .join("");
}

onSnapshot(query(collection(db, "documentos"), orderBy("creadoEn", "desc")), (snap) => {
  documentos = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  render();
}, (err) => {
  tabla.innerHTML = `<tr><td colspan="5" class="text-muted text-center">${friendlyError(err)}</td></tr>`;
});

tabla.addEventListener("click", async (e) => {
  const id = e.target.dataset.descargar;
  if (!id) return;
  const documento = documentos.find((d) => d.id === id);
  e.target.disabled = true;
  const textoOriginal = e.target.textContent;
  e.target.textContent = "Descargando...";
  try {
    const dataUrl = await obtenerArchivoComoDataUrl(documento.archivo.path);
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = documento.archivo.nombre || "documento";
    a.click();
  } catch (err) {
    alert(friendlyError(err));
  } finally {
    e.target.disabled = false;
    e.target.textContent = textoOriginal;
  }
});

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

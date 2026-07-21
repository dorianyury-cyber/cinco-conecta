import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js";
import { db, functions, showAlert, clearAlert, friendlyError } from "./utils.js";

const params = new URLSearchParams(window.location.search);
const vacanteId = params.get("vacanteId");

const form = document.getElementById("postularForm");
const alertBox = document.getElementById("postularAlert");
const submitBtn = document.getElementById("postularBtn");
const tituloEl = document.getElementById("tituloVacante");

if (!vacanteId) {
  tituloEl.textContent = "Vacante no encontrada";
  form.classList.add("hidden");
} else {
  getDoc(doc(db, "vacantes", vacanteId)).then((snap) => {
    if (!snap.exists() || snap.data().estado !== "abierta") {
      tituloEl.textContent = "Esta vacante ya no está disponible";
      form.classList.add("hidden");
      return;
    }
    tituloEl.textContent = `Postularme: ${snap.data().titulo}`;
  });
}

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
  submitBtn.disabled = true;
  submitBtn.textContent = "Enviando...";

  try {
    const archivo = document.getElementById("hojaVida").files[0];
    if (!archivo) throw new Error("Adjunta tu hoja de vida.");

    const hojaVidaBase64 = await leerArchivoComoBase64(archivo);

    const datos = {
      vacanteId,
      nombres: document.getElementById("nombres").value,
      apellidos: document.getElementById("apellidos").value,
      email: document.getElementById("email").value,
      telefono: document.getElementById("telefono").value,
      cedula: document.getElementById("cedula").value,
      hojaVidaBase64,
      hojaVidaNombre: archivo.name,
      hojaVidaTipo: archivo.type,
      sitioWeb: document.getElementById("sitioWeb").value
    };

    const llamada = httpsCallable(functions, "enviarPostulacion");
    await llamada(datos);
    showAlert(alertBox, "¡Gracias! Tu postulación fue enviada correctamente. Te llegará un correo de confirmación.", "success");
    form.reset();
  } catch (err) {
    showAlert(alertBox, friendlyError(err), "error");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Enviar postulación";
  }
});

import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js";
import { functions, showAlert, clearAlert, friendlyError } from "./utils.js";

const ETAPA_TEXTO = {
  recibido: "Recibida",
  preseleccionado: "Preseleccionado(a)",
  entrevista: "En etapa de entrevista",
  prueba: "En etapa de pruebas",
  oferta: "¡Tenemos una oferta para ti!",
  contratado: "¡Contratado(a)!",
  rechazado: "Proceso finalizado"
};

const form = document.getElementById("estadoForm");
const alertBox = document.getElementById("estadoAlert");
const btn = document.getElementById("estadoBtn");
const resultado = document.getElementById("resultadoEstado");

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearAlert(alertBox);
  resultado.innerHTML = "";
  btn.disabled = true;
  btn.textContent = "Consultando...";

  try {
    const llamada = httpsCallable(functions, "consultarEstado");
    const { data } = await llamada({
      email: document.getElementById("email").value,
      cedula: document.getElementById("cedula").value
    });

    if (!data.postulaciones || data.postulaciones.length === 0) {
      showAlert(alertBox, "No encontramos ninguna postulación con esos datos.", "info");
      return;
    }

    resultado.innerHTML = data.postulaciones
      .map((p) => `
        <div class="card">
          <h2>${p.vacanteTitulo}</h2>
          <p><strong>Estado actual:</strong> ${ETAPA_TEXTO[p.etapa] || p.etapa}</p>
          <ul class="estado-timeline">
            ${p.historialEtapas.map((h) => `
              <li>
                ${ETAPA_TEXTO[h.etapa] || h.etapa}
                ${h.fecha ? `<div class="fecha">${new Date(h.fecha).toLocaleDateString("es-CO", { year: "numeric", month: "long", day: "numeric" })}</div>` : ""}
              </li>
            `).join("")}
          </ul>
        </div>
      `)
      .join("");
  } catch (err) {
    showAlert(alertBox, friendlyError(err), "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Consultar";
  }
});

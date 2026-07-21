import {
  collection, onSnapshot, addDoc, updateDoc, doc, getDoc, getDocs, serverTimestamp, Timestamp
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js";
import { db, functions, requireAuth, wireLogoutButton, setActiveNav, showAlert, clearAlert, friendlyError, formatDate } from "./utils.js";

const { user, perfil } = await requireAuth();
wireLogoutButton();
setActiveNav();

const esAdmin = perfil.rol === "admin";
if (esAdmin) document.getElementById("crearEncuestaCard").classList.remove("hidden");

const activaEl = document.getElementById("encuestaActivaContenedor");
const historialEl = document.getElementById("historialEncuestas");

let encuestas = [];

async function renderActiva() {
  const activa = encuestas.find((e) => e.estado === "activa");
  if (!activa) {
    activaEl.innerHTML = '<div class="card"><p class="text-muted">No hay ninguna encuesta activa en este momento.</p></div>';
    return;
  }

  const votoDoc = await getDoc(doc(db, "encuestas", activa.id, "votos", user.uid));
  const yaVoto = votoDoc.exists();
  const preguntas = activa.preguntas || [];

  let cuerpoAdmin = "";
  if (esAdmin) {
    cuerpoAdmin = `
      <hr class="divider">
      <label for="planAccionInput">Cerrar esta encuesta y publicar el plan de acción</label>
      <textarea id="planAccionInput" rows="3" placeholder="Con base en sus respuestas, vamos a..."></textarea>
      <button type="button" class="btn secondary" id="cerrarEncuestaBtn">Cerrar encuesta</button>
    `;
  }

  activaEl.innerHTML = `
    <div class="card">
      <h2>${activa.titulo}</h2>
      ${yaVoto
        ? '<p class="text-muted">Ya respondiste esta encuesta — ¡gracias por tu opinión!</p>'
        : `
          <form id="responderForm">
            ${preguntas.map((p, i) => `
              <label>${p}</label>
              <div class="toolbar radio-row">
                ${[1, 2, 3, 4, 5].map((n) => `
                  <label class="radio-inline">
                    <input type="radio" name="pregunta-${i}" value="${n}" required> ${n}
                  </label>
                `).join("")}
              </div>
            `).join("")}
            <label for="comentario">Comentario (opcional)</label>
            <textarea id="comentario" rows="2" maxlength="500"></textarea>
            <div class="alert" id="responderAlert"></div>
            <button type="submit" class="btn" id="responderBtn">Enviar respuesta</button>
          </form>
        `}
      ${cuerpoAdmin}
    </div>
  `;

  if (!yaVoto) {
    document.getElementById("responderForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const alertBox = document.getElementById("responderAlert");
      const btn = document.getElementById("responderBtn");
      clearAlert(alertBox);
      btn.disabled = true;
      btn.textContent = "Enviando...";
      try {
        const respuestas = {};
        preguntas.forEach((p, i) => {
          respuestas[p] = Number(document.querySelector(`input[name="pregunta-${i}"]:checked`)?.value);
        });
        const llamada = httpsCallable(functions, "responderEncuesta");
        await llamada({ encuestaId: activa.id, respuestas, comentario: document.getElementById("comentario").value });
        await renderActiva();
      } catch (err) {
        showAlert(alertBox, friendlyError(err), "error");
        btn.disabled = false;
        btn.textContent = "Enviar respuesta";
      }
    });
  }

  if (esAdmin) {
    document.getElementById("cerrarEncuestaBtn").addEventListener("click", async () => {
      const planAccion = document.getElementById("planAccionInput").value.trim();
      if (!planAccion) {
        alert("Escribe el plan de acción antes de cerrar la encuesta.");
        return;
      }
      await updateDoc(doc(db, "encuestas", activa.id), {
        estado: "cerrada",
        planAccion,
        fechaCierre: Timestamp.now()
      });
    });
  }
}

async function renderHistorial() {
  const cerradas = encuestas.filter((e) => e.estado === "cerrada");
  if (cerradas.length === 0) {
    historialEl.innerHTML = '<p class="text-muted">Aún no hay encuestas cerradas.</p>';
    return;
  }

  const bloques = await Promise.all(cerradas.map(async (enc) => {
    let promedios = "";
    if (esAdmin) {
      const respSnap = await getDocs(collection(db, "encuestaRespuestas"));
      const respuestas = respSnap.docs.map((d) => d.data()).filter((r) => r.encuestaId === enc.id);
      const sumas = {};
      const conteos = {};
      respuestas.forEach((r) => {
        Object.entries(r.respuestas || {}).forEach(([pregunta, valor]) => {
          sumas[pregunta] = (sumas[pregunta] || 0) + valor;
          conteos[pregunta] = (conteos[pregunta] || 0) + 1;
        });
      });
      promedios = `
        <p class="text-muted text-sm">${respuestas.length} respuesta(s)</p>
        <ul class="clean-list">
          ${Object.keys(sumas).map((p) => `<li>${p}: <strong>${(sumas[p] / conteos[p]).toFixed(1)} / 5</strong></li>`).join("")}
        </ul>
      `;
    }
    return `
      <div class="card">
        <h2>${enc.titulo}</h2>
        <p class="text-muted text-sm">Cerrada el ${enc.fechaCierre ? formatDate(enc.fechaCierre) : "-"}</p>
        ${promedios}
        <p><strong>Plan de acción:</strong> ${enc.planAccion || "-"}</p>
      </div>
    `;
  }));

  historialEl.innerHTML = bloques.join("");
}

onSnapshot(collection(db, "encuestas"), (snap) => {
  encuestas = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  renderActiva();
  renderHistorial();
  if (esAdmin) {
    const hayActiva = encuestas.some((e) => e.estado === "activa");
    const card = document.getElementById("crearEncuestaCard");
    card.querySelector("form").classList.toggle("hidden", hayActiva);
    if (hayActiva && !card.querySelector(".text-muted.aviso-activa")) {
      card.insertAdjacentHTML("beforeend", '<p class="text-muted aviso-activa">Ya hay una encuesta activa — ciérrala antes de crear otra.</p>');
    } else if (!hayActiva) {
      card.querySelector(".aviso-activa")?.remove();
    }
  }
}, (err) => {
  activaEl.innerHTML = `<p class="text-muted">${friendlyError(err)}</p>`;
});

if (esAdmin) {
  document.getElementById("crearEncuestaForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const alertBox = document.getElementById("crearAlertBox");
    const btn = document.getElementById("crearEncuestaBtn");
    clearAlert(alertBox);
    btn.disabled = true;
    btn.textContent = "Publicando...";
    try {
      const preguntas = document.getElementById("preguntasEncuesta").value
        .split("\n").map((p) => p.trim()).filter(Boolean).slice(0, 3);
      if (preguntas.length === 0) throw new Error("Escribe al menos una pregunta.");
      await addDoc(collection(db, "encuestas"), {
        titulo: document.getElementById("tituloEncuesta").value.trim(),
        preguntas,
        estado: "activa",
        fechaInicio: serverTimestamp(),
        planAccion: "",
        creadoEn: serverTimestamp()
      });
      e.target.reset();
    } catch (err) {
      showAlert(alertBox, friendlyError(err), "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Publicar encuesta";
    }
  });
}

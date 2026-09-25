import {
  collection, onSnapshot, addDoc, updateDoc, deleteDoc, doc, getDoc, getDocs, query, where,
  serverTimestamp, Timestamp, writeBatch
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js";
import { db, functions, requireAuth, wireLogoutButton, setActiveNav, showAlert, clearAlert, friendlyError, formatDate, tienePermiso } from "./utils.js";
import { esc, serializarPreguntas, mismaFamiliaRespuesta, esEncabezado } from "./encuestas-tipos.js";
import { montarFormulario } from "./encuestas-responder.js";
import { crearEditor } from "./encuestas-editor.js";
import { htmlResultados } from "./encuestas-resultados.js";

const { user, perfil } = await requireAuth();
wireLogoutButton();
setActiveNav();

const esAdmin = tienePermiso(perfil, "encuestas");
if (esAdmin) document.getElementById("crearEncuestaCard").classList.remove("hidden");

const activaEl = document.getElementById("encuestaActivaContenedor");
const historialTabla = document.getElementById("historialEncuestas");

// Sin ancho en píxeles a propósito: .celda-trunc ya trae max-width:100% en
// styles.css, relativo a la celda real (fijada por el <colgroup> en % de
// encuestas.html) — mismo helper que empleados.js.
function celdaTrunc(texto) {
  return `<span class="celda-trunc" title="${(texto || "").replace(/"/g, "&quot;")}">${texto || "-"}</span>`;
}

let encuestas = [];

// ---------- Utilidades ----------

const llamar = (nombre, datos) => httpsCallable(functions, nombre)(datos).then((r) => r.data);

async function cargarRespuestas(encuestaId) {
  const snap = await getDocs(query(collection(db, "encuestaRespuestas"), where("encuestaId", "==", encuestaId)));
  return snap.docs.map((d) => d.data()).sort((a, b) => (a.creadoEn?.seconds || 0) - (b.creadoEn?.seconds || 0));
}

async function exportarExcel(enc) {
  const [{ exportarResultadosExcel }, respuestas] = await Promise.all([import("./encuestas-exportar.js"), cargarRespuestas(enc.id)]);
  await exportarResultadosExcel(enc, respuestas);
}

// El navegador no puede pedir el archivo directo a Storage (sin CORS): la
// Cloud Function lo devuelve en base64. Se descarga como Blob (una URL data:
// no la permite la CSP en fetch).
async function descargarArchivo(path, nombre) {
  const { base64, contentType } = await llamar("obtenerArchivoBase64", { path });
  const binario = atob(base64);
  const bytes = new Uint8Array(binario.length);
  for (let i = 0; i < binario.length; i++) bytes[i] = binario.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: contentType }));
  const a = document.createElement("a");
  a.href = url;
  a.download = nombre || "archivo";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

document.addEventListener("click", async (e) => {
  const boton = e.target.closest('[data-accion="descargar-archivo"]');
  if (!boton) return;
  boton.disabled = true;
  try {
    await descargarArchivo(boton.dataset.path, boton.dataset.nombre);
  } catch (err) {
    alert(friendlyError(err));
  } finally {
    boton.disabled = false;
  }
});

/** Muestra u oculta los resultados dentro de `contenedor` (los carga al abrir). */
async function alternarResultados(enc, contenedor, boton) {
  if (!contenedor.classList.contains("hidden")) {
    contenedor.classList.add("hidden");
    boton.textContent = boton.dataset.textoAbrir;
    return;
  }
  boton.disabled = true;
  contenedor.innerHTML = '<p class="text-muted">Cargando resultados...</p>';
  contenedor.classList.remove("hidden");
  try {
    contenedor.innerHTML = htmlResultados(enc, await cargarRespuestas(enc.id));
    boton.textContent = "Ocultar resultados";
  } catch (err) {
    contenedor.innerHTML = `<p class="text-muted">${esc(friendlyError(err))}</p>`;
  } finally {
    boton.disabled = false;
  }
}

async function conBoton(boton, textoEspera, tarea) {
  const original = boton.textContent;
  boton.disabled = true;
  boton.textContent = textoEspera;
  try {
    await tarea();
  } catch (err) {
    alert(friendlyError(err));
  } finally {
    boton.disabled = false;
    boton.textContent = original;
  }
}

// ---------- Responder (encuesta activa) ----------

let tokenActiva = 0;
let firmaActiva = null;

async function renderActiva({ forzar = false } = {}) {
  const activa = encuestas.find((e) => e.estado === "activa");
  const firma = JSON.stringify(activa ? [activa.id, activa.titulo, activa.descripcion || "", activa.preguntas, esAdmin] : null);
  // Si la encuesta no cambió no se vuelve a dibujar: así nadie pierde lo que
  // está escribiendo cuando llega un cambio ajeno (p. ej. otro borrador).
  if (!forzar && firma === firmaActiva) return;
  firmaActiva = firma;
  const token = ++tokenActiva;

  if (!activa) {
    activaEl.innerHTML = '<div class="card"><p class="text-muted">No hay ninguna encuesta activa en este momento.</p></div>';
    return;
  }

  const votoDoc = await getDoc(doc(db, "encuestas", activa.id, "votos", user.uid));
  if (token !== tokenActiva) return;
  const yaVoto = votoDoc.exists();

  const cuerpoAdmin = esAdmin ? `
    <hr class="divider">
    <div class="encuesta-acciones">
      <button type="button" class="btn secondary btn-auto btn-sm" id="editarActivaBtn">Editar encuesta</button>
      <button type="button" class="btn secondary btn-auto btn-sm" id="resultadosActivaBtn" data-texto-abrir="Ver resultados parciales">Ver resultados parciales</button>
      <button type="button" class="btn secondary btn-auto btn-sm" id="exportarActivaBtn">Exportar a Excel</button>
      <button type="button" class="btn secondary btn-auto btn-sm" id="notificarToggleBtn">📧 Notificar a todo el personal</button>
    </div>
    <div id="resultadosActiva" class="hidden"></div>
    ${activa.notificadoEn ? `<p class="text-muted text-sm">📧 Notificado por ${esc(activa.notificadoPorNombre || "-")} · ${formatDate(activa.notificadoEn)}</p>` : ""}
    <div class="card hidden" id="notificarPanel">
      <label class="checkbox-row"><input type="checkbox" id="notificarModoPrueba"> Modo prueba — enviar solo un correo de ejemplo a gerencia.cincoltda@hotmail.com (no le llega a nadie más, no queda registrado como notificación real)</label>
      <button type="button" class="btn btn-auto mt-4" id="notificarEnviarBtn">Enviar notificación</button>
      <div class="alert" id="notificarAlertBox"></div>
    </div>
    <hr class="divider">
    <label for="planAccionInput">Cerrar esta encuesta y publicar el plan de acción</label>
    <textarea id="planAccionInput" rows="3" placeholder="Con base en sus respuestas, vamos a..."></textarea>
    <button type="button" class="btn secondary" id="cerrarEncuestaBtn">Cerrar encuesta</button>
  ` : "";

  activaEl.innerHTML = `
    <div class="card">
      <h2>${esc(activa.titulo)}</h2>
      ${activa.descripcion ? `<p class="encuesta-descripcion">${esc(activa.descripcion)}</p>` : ""}
      ${yaVoto
        ? '<p class="text-muted">Ya respondiste esta encuesta — ¡gracias por tu opinión!</p>'
        : `
          <form id="responderForm" novalidate>
            <div id="formPreguntas"></div>
            <label for="comentario">Comentario (opcional)</label>
            <textarea id="comentario" rows="2" maxlength="500"></textarea>
            <p class="text-muted text-sm">Tus respuestas son anónimas.</p>
            <div class="alert" id="responderAlert"></div>
            <div class="progreso-subida" id="progresoSubida"></div>
            <button type="submit" class="btn" id="responderBtn">Enviar respuesta</button>
          </form>
        `}
      ${cuerpoAdmin}
    </div>
  `;

  if (!yaVoto) {
    const formulario = montarFormulario({
      host: document.getElementById("formPreguntas"),
      preguntas: activa.preguntas || [],
      subirArchivo: ({ preguntaId, nombre, base64 }) => llamar("subirArchivoEncuesta", { encuestaId: activa.id, preguntaId, nombre, base64 })
    });
    document.getElementById("responderForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const alertBox = document.getElementById("responderAlert");
      const progreso = document.getElementById("progresoSubida");
      const btn = document.getElementById("responderBtn");
      clearAlert(alertBox);
      btn.disabled = true;
      btn.textContent = "Enviando...";
      try {
        const respuestas = await formulario.obtenerRespuestas((texto) => { progreso.textContent = texto; });
        if (!respuestas) {
          showAlert(alertBox, "Revisa las preguntas marcadas en rojo.", "error");
          btn.disabled = false;
          btn.textContent = "Enviar respuesta";
          return;
        }
        progreso.textContent = "Enviando respuesta...";
        await llamar("responderEncuesta", { encuestaId: activa.id, respuestas, comentario: document.getElementById("comentario").value });
        await renderActiva({ forzar: true });
      } catch (err) {
        showAlert(alertBox, friendlyError(err), "error");
        progreso.textContent = "";
        btn.disabled = false;
        btn.textContent = "Enviar respuesta";
      }
    });
  }

  if (esAdmin) {
    document.getElementById("editarActivaBtn").addEventListener("click", () => cargarEnEditor({ modo: "activa", id: activa.id, encuesta: activa }));
    const resultadosBtn = document.getElementById("resultadosActivaBtn");
    resultadosBtn.addEventListener("click", () => alternarResultados(activa, document.getElementById("resultadosActiva"), resultadosBtn));
    const exportarBtn = document.getElementById("exportarActivaBtn");
    exportarBtn.addEventListener("click", () => conBoton(exportarBtn, "Exportando...", () => exportarExcel(activa)));
    document.getElementById("notificarToggleBtn").addEventListener("click", () => {
      document.getElementById("notificarPanel").classList.toggle("hidden");
    });
    document.getElementById("notificarEnviarBtn").addEventListener("click", async (e) => {
      const alertBox = document.getElementById("notificarAlertBox");
      clearAlert(alertBox);
      const modoPrueba = document.getElementById("notificarModoPrueba").checked;
      if (!modoPrueba && !confirm("¿Enviar la notificación por correo a todo el personal activo?")) return;
      const btn = e.target;
      btn.disabled = true;
      const textoOriginal = btn.textContent;
      btn.textContent = "Enviando...";
      try {
        const data = await llamar("notificarEncuesta", { encuestaId: activa.id, modoPrueba });
        const mensaje = data.prueba
          ? "Correo de prueba enviado a gerencia.cincoltda@hotmail.com — revísalo antes de notificar a todos."
          : `Notificación enviada a ${data.enviados.length} persona(s).${data.sinCorreo.length ? ` Sin correo registrado (no se les pudo notificar): ${data.sinCorreo.join(", ")}.` : ""}`;
        showAlert(alertBox, mensaje, "success");
      } catch (err) {
        showAlert(alertBox, friendlyError(err), "error");
      } finally {
        btn.disabled = false;
        btn.textContent = textoOriginal;
      }
    });
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

// ---------- Historial ----------
// Mismo patrón de "fila delgada + panel de vista previa fijo arriba" que
// Empleados (ver empleados.js): la tabla es de una sola línea por encuesta,
// sin acciones; clic en una fila la deja fijada en el panel, donde vive el
// detalle completo (descripción, plan de acción, resultados) y las
// acciones. Al entrar o cuando la fijada ya no existe, se fija sola la
// primera fila, para que el panel nunca arranque vacío.

let firmaHistorial = null;
let historialSeleccionadoId = null;

function encuestasCerradas() {
  return encuestas
    .filter((e) => e.estado === "cerrada")
    .sort((a, b) => (b.fechaCierre?.seconds || 0) - (a.fechaCierre?.seconds || 0));
}

// Las encuestas antiguas guardaban cada pregunta como un string (sin tipo).
const contarPreguntas = (enc) => (enc.preguntas || []).filter((p) => typeof p === "string" || !esEncabezado(p.tipo)).length;

function renderHistorial() {
  const cerradas = encuestasCerradas();
  const firma = JSON.stringify([esAdmin, cerradas.map((e) => [e.id, e.titulo, e.planAccion, e.fechaCierre?.seconds])]);
  if (firma === firmaHistorial) return;
  firmaHistorial = firma;

  if (cerradas.length === 0) {
    historialTabla.innerHTML = '<tr><td colspan="3" class="text-muted text-center">Aún no hay encuestas cerradas.</td></tr>';
    historialSeleccionadoId = null;
    pintarVistaPreviaHistorial();
    return;
  }
  if (!historialSeleccionadoId || !cerradas.some((e) => e.id === historialSeleccionadoId)) {
    historialSeleccionadoId = cerradas[0].id;
  }
  historialTabla.innerHTML = cerradas.map((enc) => `
    <tr data-id="${esc(enc.id)}">
      <td style="font-weight:600;">${celdaTrunc(enc.titulo)}</td>
      <td>${enc.fechaCierre ? formatDate(enc.fechaCierre) : "-"}</td>
      <td>${contarPreguntas(enc)}</td>
    </tr>`).join("");
  historialTabla.querySelectorAll("tr[data-id]").forEach((tr) => {
    tr.addEventListener("click", () => {
      historialSeleccionadoId = tr.getAttribute("data-id");
      actualizarResaltadoHistorial();
      pintarVistaPreviaHistorial();
    });
  });
  actualizarResaltadoHistorial();
  pintarVistaPreviaHistorial();
}

function actualizarResaltadoHistorial() {
  historialTabla.querySelectorAll("tr[data-id]").forEach((tr) => {
    tr.classList.toggle("fila-fijada", tr.getAttribute("data-id") === historialSeleccionadoId);
  });
}

const vistaPreviaHistorialEl = document.getElementById("vistaPreviaEncuesta");

function pintarVistaPreviaHistorial() {
  const enc = encuestas.find((x) => x.id === historialSeleccionadoId);
  if (!enc) {
    vistaPreviaHistorialEl.innerHTML = '<p class="text-muted" style="margin:0;">Aún no hay encuestas cerradas.</p>';
    return;
  }
  const acciones = esAdmin ? `
    <button type="button" class="btn secondary btn-auto btn-sm" data-accion="resultados" data-texto-abrir="Ver resultados">Ver resultados</button>
    <button type="button" class="btn secondary btn-auto btn-sm" data-accion="exportar">Exportar a Excel</button>
    <button type="button" class="btn secondary btn-auto btn-sm" data-accion="duplicar">Duplicar como borrador</button>
  ` : "";
  vistaPreviaHistorialEl.innerHTML = `
    <div class="vp-encabezado">
      <span class="vp-nombre">${esc(enc.titulo)}</span>
      <div class="vp-acciones">${acciones}</div>
    </div>
    <p class="text-muted text-sm" style="margin:0;">Cerrada el ${enc.fechaCierre ? formatDate(enc.fechaCierre) : "-"}</p>
    ${enc.descripcion ? `<p class="encuesta-descripcion">${esc(enc.descripcion)}</p>` : ""}
    <p style="margin:0;"><strong>Plan de acción:</strong> ${esc(enc.planAccion) || "-"}</p>
    ${esAdmin ? '<div class="hidden" data-resultados></div>' : ""}
  `;
}

vistaPreviaHistorialEl.addEventListener("click", async (e) => {
  const boton = e.target.closest("[data-accion]");
  if (!boton || boton.dataset.accion === "descargar-archivo") return;
  const enc = encuestas.find((x) => x.id === historialSeleccionadoId);
  if (!enc) return;
  if (boton.dataset.accion === "resultados") {
    await alternarResultados(enc, vistaPreviaHistorialEl.querySelector("[data-resultados]"), boton);
  } else if (boton.dataset.accion === "exportar") {
    await conBoton(boton, "Exportando...", () => exportarExcel(enc));
  } else if (boton.dataset.accion === "duplicar") {
    await conBoton(boton, "Duplicando...", async () => {
      const ref = await addDoc(collection(db, "encuestasBorradores"), {
        titulo: `${enc.titulo} (copia)`.slice(0, 150),
        descripcion: enc.descripcion || "",
        preguntas: (enc.preguntas || []).map((p) => (typeof p === "string" ? { id: p, texto: p, tipo: "corta", obligatoria: true } : p)),
        creadoEn: serverTimestamp(),
        actualizadoEn: serverTimestamp()
      });
      const copia = await getDoc(ref);
      cargarEnEditor({ modo: "borrador", id: ref.id, encuesta: copia.data() });
    });
  }
});

onSnapshot(collection(db, "encuestas"), (snap) => {
  encuestas = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  renderActiva();
  renderHistorial();
  if (esAdmin) alCambiarEncuestas();
}, (err) => {
  activaEl.innerHTML = `<p class="text-muted">${esc(friendlyError(err))}</p>`;
});

// ---------- Crear / editar encuesta (solo con permiso "encuestas") ----------

let cargarEnEditor = () => {};
let alCambiarEncuestas = () => {};

if (esAdmin) {
  const tarjeta = document.getElementById("crearEncuestaCard");
  const form = document.getElementById("crearEncuestaForm");
  const tituloEl = document.getElementById("tituloEncuesta");
  const descripcionEl = document.getElementById("descripcionEncuesta");
  const tituloTrigger = document.getElementById("editorTitulo");
  const avisoEl = document.getElementById("editorAviso");
  const alertBox = document.getElementById("crearAlertBox");
  const publicarBtn = document.getElementById("crearEncuestaBtn");
  const borradorBtn = document.getElementById("guardarBorradorBtn");
  const cancelarBtn = document.getElementById("cancelarEdicionBtn");
  const notaPublicar = document.getElementById("publicarNota");
  const borradoresEl = document.getElementById("borradoresLista");

  let ctx = { modo: "nueva", id: null };
  let respuestasExistentes = 0;
  let sucio = false;
  let borradores = [];

  const editor = crearEditor(document.getElementById("preguntasBuilder"), {
    alCambiar: () => { sucio = true; },
    // Cambiar el tipo de una pregunta que ya tiene respuestas las deja fuera de
    // los resultados (la pregunta recibe un id nuevo): se pide confirmación.
    confirmarCambioTipo: (q, tipoNuevo) => {
      if (ctx.modo !== "activa" || respuestasExistentes === 0 || !q.origen || mismaFamiliaRespuesta(q.origen.tipo, tipoNuevo)) return true;
      return confirm(`Esta encuesta ya tiene ${respuestasExistentes} respuesta(s). Si cambias el tipo de esta pregunta, las respuestas anteriores a ella dejarán de mostrarse en los resultados. ¿Continuar?`);
    }
  });
  tituloEl.addEventListener("input", () => { sucio = true; });
  descripcionEl.addEventListener("input", () => { sucio = true; });
  window.addEventListener("beforeunload", (e) => {
    if (sucio) e.preventDefault();
  });

  function actualizarBotones() {
    const editandoActiva = ctx.modo === "activa";
    const hayActiva = encuestas.some((x) => x.estado === "activa");
    const bloqueada = !editandoActiva && hayActiva;
    tituloTrigger.textContent = editandoActiva ? "Editando la encuesta activa"
      : ctx.modo === "borrador" ? "Editando un borrador" : "Nueva encuesta";
    publicarBtn.textContent = editandoActiva ? "Guardar cambios" : "Publicar encuesta";
    publicarBtn.disabled = bloqueada;
    borradorBtn.classList.toggle("hidden", editandoActiva);
    cancelarBtn.classList.toggle("hidden", ctx.modo === "nueva");
    notaPublicar.textContent = bloqueada ? "Ya hay una encuesta activa — ciérrala antes de publicar otra. Mientras tanto puedes guardar esta como borrador." : "";
  }

  function reiniciar() {
    ctx = { modo: "nueva", id: null };
    respuestasExistentes = 0;
    tituloEl.value = "";
    descripcionEl.value = "";
    editor.reiniciar();
    clearAlert(alertBox);
    clearAlert(avisoEl);
    sucio = false;
    actualizarBotones();
  }

  cargarEnEditor = async ({ modo, id, encuesta }) => {
    if (sucio && !confirm("Tienes cambios sin guardar en el editor. ¿Descartarlos y cargar esta encuesta?")) return;
    ctx = { modo, id };
    tituloEl.value = encuesta.titulo || "";
    descripcionEl.value = encuesta.descripcion || "";
    editor.cargar(encuesta.preguntas || []);
    clearAlert(alertBox);
    clearAlert(avisoEl);
    sucio = false;
    actualizarBotones();
    tarjeta.classList.add("abierto");
    tarjeta.scrollIntoView({ behavior: "smooth", block: "start" });
    if (modo === "activa") {
      try {
        respuestasExistentes = (await cargarRespuestas(id)).length;
      } catch {
        respuestasExistentes = 0;
      }
      if (ctx.id === id && respuestasExistentes > 0) {
        showAlert(avisoEl, `Esta encuesta ya tiene ${respuestasExistentes} respuesta(s). Puedes corregir textos, pero quitar o renombrar opciones, filas o columnas puede dejar respuestas anteriores sin contar; y cambiar el tipo de una pregunta la separa de sus respuestas anteriores.`, "warn");
      }
    }
  };

  alCambiarEncuestas = () => {
    // Si la encuesta que se editaba se cerró mientras tanto, se sale del modo edición.
    if (ctx.modo === "activa" && !encuestas.some((x) => x.id === ctx.id && x.estado === "activa")) {
      reiniciar();
      showAlert(avisoEl, "La encuesta que estabas editando ya no está activa.", "info");
    }
    actualizarBotones();
  };

  cancelarBtn.addEventListener("click", () => {
    if (sucio && !confirm("¿Descartar los cambios sin guardar?")) return;
    reiniciar();
  });

  // ---- Borradores ----
  onSnapshot(collection(db, "encuestasBorradores"), (snap) => {
    borradores = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.actualizadoEn?.seconds || 0) - (a.actualizadoEn?.seconds || 0));
    borradoresEl.innerHTML = borradores.length === 0 ? "" : `
      <label>Borradores guardados</label>
      ${borradores.map((b) => `
        <div class="card item-card borrador-item" data-id="${esc(b.id)}">
          <div><strong>${esc(b.titulo) || "(Sin título)"}</strong>
            <span class="text-muted text-sm"> · ${(b.preguntas || []).length} pregunta(s) · ${b.actualizadoEn ? formatDate(b.actualizadoEn) : "-"}</span></div>
          <div class="acciones">
            <button type="button" class="btn secondary btn-auto btn-sm" data-accion="continuar">Continuar editando</button>
            <button type="button" class="btn secondary btn-auto btn-sm peligro" data-accion="eliminar">Eliminar</button>
          </div>
        </div>`).join("")}
      <hr class="divider">`;
  }, () => { borradoresEl.innerHTML = ""; });

  borradoresEl.addEventListener("click", async (e) => {
    const boton = e.target.closest("[data-accion]");
    const b = borradores.find((x) => x.id === boton?.closest("[data-id]")?.dataset.id);
    if (!boton || !b) return;
    if (boton.dataset.accion === "continuar") {
      cargarEnEditor({ modo: "borrador", id: b.id, encuesta: b });
    } else if (confirm(`¿Eliminar el borrador "${b.titulo || "(Sin título)"}"?`)) {
      await conBoton(boton, "Eliminando...", async () => {
        await deleteDoc(doc(db, "encuestasBorradores", b.id));
        if (ctx.modo === "borrador" && ctx.id === b.id) reiniciar();
      });
    }
  });

  borradorBtn.addEventListener("click", async () => {
    clearAlert(alertBox);
    const titulo = tituloEl.value.trim();
    if (!titulo) {
      showAlert(alertBox, "Escribe el título para guardar el borrador.", "error");
      tituloEl.focus();
      return;
    }
    borradorBtn.disabled = true;
    borradorBtn.textContent = "Guardando...";
    try {
      const datos = {
        titulo,
        descripcion: descripcionEl.value.trim(),
        preguntas: serializarPreguntas(editor.obtener(), false),
        actualizadoEn: serverTimestamp()
      };
      if (ctx.modo === "borrador") {
        await updateDoc(doc(db, "encuestasBorradores", ctx.id), datos);
      } else {
        const ref = await addDoc(collection(db, "encuestasBorradores"), { ...datos, creadoEn: serverTimestamp() });
        ctx = { modo: "borrador", id: ref.id };
      }
      sucio = false;
      actualizarBotones();
      showAlert(alertBox, "Borrador guardado. Puedes seguir editando o publicarlo cuando esté listo.", "success");
    } catch (err) {
      showAlert(alertBox, friendlyError(err), "error");
    } finally {
      borradorBtn.disabled = false;
      borradorBtn.textContent = "Guardar borrador";
    }
  });

  // ---- Vista previa: el mismo formulario que ve el trabajador ----
  const previewBackdrop = document.getElementById("previewBackdrop");
  const previewContenido = document.getElementById("previewContenido");
  const previewCelular = document.getElementById("previewCelular");
  previewCelular.addEventListener("change", () => previewContenido.classList.toggle("vista-celular", previewCelular.checked));
  const cerrarPreview = () => previewBackdrop.classList.remove("open");
  document.getElementById("cerrarPreviewBtn").addEventListener("click", cerrarPreview);
  previewBackdrop.addEventListener("click", (e) => { if (e.target === previewBackdrop) cerrarPreview(); });

  document.getElementById("vistaPreviaBtn").addEventListener("click", () => {
    const preguntas = serializarPreguntas(editor.obtener(), false).map((p) => ({ ...p, texto: p.texto || (esEncabezado(p.tipo) ? "(Encabezado sin título)" : "(Pregunta sin enunciado)") }));
    previewContenido.innerHTML = `
      <div class="card">
        <h2>${esc(tituloEl.value.trim()) || "(Sin título)"}</h2>
        ${descripcionEl.value.trim() ? `<p class="encuesta-descripcion">${esc(descripcionEl.value.trim())}</p>` : ""}
        <div id="previewPreguntas"></div>
        <label>Comentario (opcional)</label>
        <textarea rows="2" disabled></textarea>
        <button type="button" class="btn" disabled>Enviar respuesta</button>
      </div>`;
    montarFormulario({
      host: document.getElementById("previewPreguntas"),
      preguntas,
      subirArchivo: async () => { throw new Error("En la vista previa no se suben archivos."); }
    });
    previewBackdrop.classList.add("open");
  });

  // ---- Publicar / guardar cambios ----
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearAlert(alertBox);
    publicarBtn.disabled = true;
    const textoOriginal = publicarBtn.textContent;
    publicarBtn.textContent = ctx.modo === "activa" ? "Guardando..." : "Publicando...";
    try {
      const titulo = tituloEl.value.trim();
      if (!titulo) throw new Error("Escribe el título de la encuesta.");
      const datos = { titulo, descripcion: descripcionEl.value.trim(), preguntas: serializarPreguntas(editor.obtener(), true) };

      if (ctx.modo === "activa") {
        await updateDoc(doc(db, "encuestas", ctx.id), { ...datos, editadoEn: serverTimestamp() });
        reiniciar();
        tarjeta.classList.remove("abierto");
        return;
      }
      if (encuestas.some((x) => x.estado === "activa")) {
        throw new Error("Ya hay una encuesta activa — ciérrala antes de publicar otra. Puedes guardar esta como borrador.");
      }
      const lote = writeBatch(db);
      lote.set(doc(collection(db, "encuestas")), {
        ...datos,
        estado: "activa",
        fechaInicio: serverTimestamp(),
        planAccion: "",
        creadoEn: serverTimestamp()
      });
      if (ctx.modo === "borrador") lote.delete(doc(db, "encuestasBorradores", ctx.id));
      await lote.commit();
      reiniciar();
      tarjeta.classList.remove("abierto");
    } catch (err) {
      showAlert(alertBox, friendlyError(err), "error");
      publicarBtn.textContent = textoOriginal;
      publicarBtn.disabled = false;
      return;
    }
    actualizarBotones();
  });

  actualizarBotones();
}

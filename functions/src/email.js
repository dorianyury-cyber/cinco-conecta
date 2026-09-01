const nodemailer = require("nodemailer");

// SMTP_USER / SMTP_PASS se cargan como variables de entorno (functions/.env
// en local, o generado por el workflow de GitHub Actions a partir de los
// "Secrets" del repositorio — nunca se escriben a mano ni se suben al repo).
const DESTINATARIO_RRHH = "gerencia.cincoltda@hotmail.com";
const BASE_URL = "https://cinco-conecta.web.app";
const LOGO_URL = `${BASE_URL}/assets/img/logo.png`;

function buildTransporter() {
  return nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 10000
  });
}

const ETAPA_TEXTO = {
  recibido: "Recibida",
  preseleccionado: "Preseleccionado(a)",
  entrevista: "En etapa de entrevista",
  prueba: "En etapa de pruebas",
  oferta: "¡Tenemos una oferta para ti!",
  contratado: "¡Contratado(a)!",
  rechazado: "Proceso finalizado"
};

async function enviarConfirmacionPostulacion({ nombres, email, tituloVacante }) {
  const transporter = buildTransporter();
  await transporter.sendMail({
    from: `"Cinco S.A.S. - Talento Humano" <${process.env.SMTP_USER}>`,
    to: email,
    subject: `Recibimos tu postulación a "${tituloVacante}"`,
    text: [
      `Hola ${nombres},`,
      "",
      `Gracias por postularte a la vacante "${tituloVacante}" en Cinco S.A.S.`,
      "Ya recibimos tu información y hoja de vida — te avisaremos por este mismo correo cada vez que tu proceso avance.",
      "",
      "Puedes consultar el estado de tu postulación en cualquier momento desde nuestro sitio, en la sección Trabaja con Nosotros.",
      "",
      "Cinco S.A.S."
    ].join("\n")
  });
}

async function enviarNotificacionRRHH({ nombres, apellidos, email, telefono, tituloVacante }) {
  const transporter = buildTransporter();
  await transporter.sendMail({
    from: `"Cinco Conecta" <${process.env.SMTP_USER}>`,
    to: DESTINATARIO_RRHH,
    replyTo: email,
    subject: `Nueva postulación: ${nombres} ${apellidos} — ${tituloVacante}`,
    text: [
      `Vacante: ${tituloVacante}`,
      `Nombre: ${nombres} ${apellidos}`,
      `Email: ${email}`,
      `Teléfono: ${telefono}`
    ].join("\n")
  });
}

async function enviarCambioEtapa({ nombres, email, tituloVacante, etapa }) {
  const transporter = buildTransporter();
  const etapaTexto = ETAPA_TEXTO[etapa] || etapa;
  await transporter.sendMail({
    from: `"Cinco S.A.S. - Talento Humano" <${process.env.SMTP_USER}>`,
    to: email,
    subject: `Actualización de tu postulación a "${tituloVacante}"`,
    text: [
      `Hola ${nombres},`,
      "",
      `Tu proceso de selección para "${tituloVacante}" tiene una actualización:`,
      "",
      etapaTexto,
      "",
      "Puedes consultar el detalle en nuestro sitio, en la sección Trabaja con Nosotros.",
      "",
      "Cinco S.A.S."
    ].join("\n")
  });
}

// ---- plantilla HTML compartida (mismo lenguaje visual navy/ámbar en todos
// los correos de la app: encabezado blanco con logo, franja degradada,
// cuerpo oscuro, botón ámbar, pie con la firma de la firma). Cada correo
// solo arma su propio "cuerpoHtml" (una serie de <tr><td>...) y lo envuelve
// con esto. ----
function envolverCorreoHtml({ subtitulo, cuerpoHtml }) {
  return `
  <!doctype html>
  <html>
  <body style="margin:0;padding:0;background:#12161d;font-family:'Segoe UI',Roboto,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#12161d;">
      <tr>
        <td align="center" style="padding:24px;">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:#1c2027;border-radius:16px;overflow:hidden;border:1px solid #2a2f38;">
            <tr>
              <td style="padding:20px 28px;background:#ffffff;">
                <table role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="padding-right:12px;">
                      <img src="${LOGO_URL}" width="40" alt="Cinco S.A.S." style="display:block;">
                    </td>
                    <td>
                      <div style="color:#12161d;font-size:15px;font-weight:700;">Cinco Conecta</div>
                      <div style="color:#5a5a5a;font-size:12px;">${subtitulo} · Cinco S.A.S.</div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="height:3px;background:linear-gradient(90deg,#feb209,#d99400);font-size:0;line-height:0;">&nbsp;</td>
            </tr>
            ${cuerpoHtml}
          </table>
          <p style="text-align:center;color:#555;font-size:11px;margin:16px 0 0;">
            Cinco S.A.S. · Construcción, Ingeniería y Consultoría
          </p>
        </td>
      </tr>
    </table>
  </body>
  </html>`;
}

// Caja destacada con borde ámbar para usuario/contraseña temporal —
// reutilizada en el correo de bienvenida y en el de nueva contraseña.
function credencialesHtml({ correo, password }) {
  return `
    <tr>
      <td style="padding:16px 28px 6px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#232833;border-radius:12px;border:1px solid #feb209;">
          <tr>
            <td style="padding:18px 20px;">
              <div style="color:#9aa1ab;font-size:12px;margin-bottom:2px;">Usuario</div>
              <div style="color:#ffffff;font-size:14.5px;font-weight:600;margin-bottom:14px;">${correo}</div>
              <div style="color:#9aa1ab;font-size:12px;margin-bottom:2px;">Contraseña temporal</div>
              <div style="color:#feb209;font-size:20px;font-weight:800;letter-spacing:2px;">${password}</div>
            </td>
          </tr>
        </table>
      </td>
    </tr>`;
}

function botonHtml(texto, url) {
  return `
    <tr>
      <td style="padding:22px 28px 6px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td align="center">
              <a href="${url}" style="display:inline-block;background:#feb209;color:#12161d;font-weight:800;font-size:15px;text-decoration:none;padding:14px 28px;border-radius:10px;">
                ${texto}
              </a>
            </td>
          </tr>
        </table>
      </td>
    </tr>`;
}

async function enviarBienvenidaEmpleado({ nombre, correo, password }) {
  const transporter = buildTransporter();
  const cuerpoHtml = `
    <tr>
      <td style="padding:30px 28px 4px;text-align:center;">
        <div style="font-size:38px;line-height:1;margin-bottom:10px;">🎉</div>
        <h1 style="color:#ffffff;font-size:22px;margin:0 0 8px;">¡Bienvenido(a), ${nombre}!</h1>
        <p style="color:#c7c7c7;font-size:14px;line-height:1.5;margin:0;">
          Ya tienes acceso a Cinco Conecta, la plataforma interna de Cinco S.A.S.: reconoce a tus compañeros, participa en las encuestas y entérate de los comunicados de la empresa.
        </p>
      </td>
    </tr>
    <tr>
      <td style="padding:18px 28px 0;">
        <div style="color:#feb209;font-size:12.5px;font-weight:700;letter-spacing:.5px;">🔑 TUS ACCESOS</div>
      </td>
    </tr>
    ${credencialesHtml({ correo, password })}
    ${botonHtml("Ingresar a la plataforma", `${BASE_URL}/login.html`)}
    <tr>
      <td style="padding:16px 28px 30px;">
        <p style="color:#8a8a8a;font-size:12.5px;line-height:1.5;margin:0;">Por seguridad, la plataforma te pedirá cambiar esta contraseña la primera vez que ingreses.</p>
      </td>
    </tr>`;
  await transporter.sendMail({
    from: `"Cinco Conecta" <${process.env.SMTP_USER}>`,
    replyTo: DESTINATARIO_RRHH,
    to: correo,
    subject: "Bienvenido(a) a Cinco Conecta — tus datos de acceso",
    html: envolverCorreoHtml({ subtitulo: "Talento Humano", cuerpoHtml })
  });
}

async function enviarNuevaPasswordEmpleado({ nombre, correo, password }) {
  const transporter = buildTransporter();
  const cuerpoHtml = `
    <tr>
      <td style="padding:26px 28px 4px;">
        <h1 style="color:#ffffff;font-size:20px;margin:0 0 12px;">Nueva contraseña temporal</h1>
        <p style="color:#c7c7c7;font-size:14px;line-height:1.5;margin:0;">
          Hola ${nombre}, un administrador generó una nueva contraseña temporal para tu cuenta de Cinco Conecta.
        </p>
      </td>
    </tr>
    ${credencialesHtml({ correo, password })}
    ${botonHtml("Ingresar a la plataforma", `${BASE_URL}/login.html`)}
    <tr>
      <td style="padding:16px 28px 30px;">
        <p style="color:#8a8a8a;font-size:12.5px;line-height:1.5;margin:0;">Por seguridad, la plataforma te pedirá cambiarla apenas ingreses.</p>
      </td>
    </tr>`;
  await transporter.sendMail({
    from: `"Cinco Conecta" <${process.env.SMTP_USER}>`,
    replyTo: DESTINATARIO_RRHH,
    to: correo,
    subject: "Cinco Conecta — se generó una nueva contraseña temporal",
    html: envolverCorreoHtml({ subtitulo: "Talento Humano", cuerpoHtml })
  });
}

function formatearFechaHoraLarga(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("es-CO", { day: "numeric", month: "long", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
}

function asignacionInformeGestionHtml({ nombre, contrato, periodoLabel, secciones, fechaLimite, url }) {
  const filasSecciones = secciones.map((s) => `
    <tr>
      <td style="padding:7px 0;color:#ffffff;font-size:13.5px;border-bottom:1px solid #2a2f38;">📌 ${s}</td>
    </tr>`).join("");
  const fechaHtml = fechaLimite ? `
    <tr>
      <td style="padding:18px 28px 6px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#232833;border-radius:12px;border:1px solid #feb209;">
          <tr>
            <td style="padding:16px 18px;">
              <div style="color:#9aa1ab;font-size:12px;margin-bottom:2px;">⏰ Fecha y hora límite para entregar lo asignado</div>
              <div style="color:#feb209;font-size:16px;font-weight:800;">${formatearFechaHoraLarga(fechaLimite)}</div>
            </td>
          </tr>
        </table>
      </td>
    </tr>` : "";

  const cuerpoHtml = `
    <tr>
      <td style="padding:26px 28px 4px;">
        <h1 style="color:#ffffff;font-size:20px;margin:0 0 12px;">Tienes ${secciones.length > 1 ? "secciones asignadas" : "una sección asignada"}</h1>
        <p style="color:#c7c7c7;font-size:14px;line-height:1.5;margin:0;">
          Hola ${nombre}, quedaste como responsable en el Informe de Gestión de <strong style="color:#ffffff;">${contrato}</strong> — ${periodoLabel}:
        </p>
      </td>
    </tr>
    <tr>
      <td style="padding:14px 28px 4px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${filasSecciones}</table>
      </td>
    </tr>
    ${fechaHtml}
    ${botonHtml("Ir al informe", url)}
    <tr>
      <td style="padding:16px 28px 30px;">
        <p style="color:#8a8a8a;font-size:12px;line-height:1.5;margin:0 0 4px;">Si el botón no funciona, copia y pega este enlace:</p>
        <p style="color:#9aa1ab;font-size:11.5px;word-break:break-all;margin:0;">${url}</p>
      </td>
    </tr>`;
  return envolverCorreoHtml({ subtitulo: "Informes de Gestión", cuerpoHtml });
}

async function enviarAsignacionInformeGestion({ nombre, correo, contrato, periodoLabel, secciones, fechaLimite, url }) {
  const transporter = buildTransporter();
  await transporter.sendMail({
    from: `"Cinco Conecta" <${process.env.SMTP_USER}>`,
    replyTo: DESTINATARIO_RRHH,
    to: correo,
    subject: `Tienes ${secciones.length > 1 ? "secciones asignadas" : "una sección asignada"} — Informe de Gestión ${contrato} (${periodoLabel})`,
    html: asignacionInformeGestionHtml({ nombre, contrato, periodoLabel, secciones, fechaLimite, url })
  });
}

// Aviso de incumplimiento: se envía a mano (botón "Notificar incumplimientos"
// en informes-gestion.js), solo después de vencida la fecha límite, a quien
// todavía tenga secciones sin completar — con copia a RRHH/gerencia para que
// quede un respaldo centralizado del aviso, además del correo del
// responsable. Usa el mismo esqueleto que el resto de correos, pero con
// acento rojo (en vez de ámbar) para que se note la diferencia de un vistazo
// frente a la asignación normal.
function incumplimientoInformeGestionHtml({ nombre, contrato, periodoLabel, secciones, fechaLimite, url }) {
  const filasSecciones = secciones.map((s) => `
    <tr>
      <td style="padding:7px 0;color:#ffffff;font-size:13.5px;border-bottom:1px solid #2a2f38;">📌 ${s}</td>
    </tr>`).join("");

  const cuerpoHtml = `
    <tr>
      <td style="padding:26px 28px 4px;">
        <h1 style="color:#ffffff;font-size:20px;margin:0 0 12px;">⚠️ Aviso de incumplimiento</h1>
        <p style="color:#c7c7c7;font-size:14px;line-height:1.5;margin:0;">
          Hola ${nombre}, la fecha y hora límite para entregar tu(s) sección(es) del Informe de Gestión de <strong style="color:#ffffff;">${contrato}</strong> — ${periodoLabel} ya se venció y, a la fecha de este correo, no se había recibido la siguiente información a tu cargo:
        </p>
      </td>
    </tr>
    <tr>
      <td style="padding:14px 28px 4px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${filasSecciones}</table>
      </td>
    </tr>
    <tr>
      <td style="padding:18px 28px 6px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#2b1c1c;border-radius:12px;border:1px solid #d64545;">
          <tr>
            <td style="padding:16px 18px;">
              <div style="color:#e3a3a3;font-size:12px;margin-bottom:2px;">⏰ Fecha y hora límite (ya vencida)</div>
              <div style="color:#ff8a8a;font-size:16px;font-weight:800;">${formatearFechaHoraLarga(fechaLimite)}</div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
    <tr>
      <td style="padding:16px 28px 4px;">
        <p style="color:#9aa1ab;font-size:12px;line-height:1.5;margin:0;">
          Este correo queda como constancia del incumplimiento de la fecha límite establecida. Por favor entrega la información pendiente lo antes posible.
        </p>
      </td>
    </tr>
    ${botonHtml("Ir al informe", url)}
    <tr>
      <td style="padding:16px 28px 30px;">
        <p style="color:#8a8a8a;font-size:12px;line-height:1.5;margin:0 0 4px;">Si el botón no funciona, copia y pega este enlace:</p>
        <p style="color:#9aa1ab;font-size:11.5px;word-break:break-all;margin:0;">${url}</p>
      </td>
    </tr>`;
  return envolverCorreoHtml({ subtitulo: "Informes de Gestión", cuerpoHtml });
}

async function enviarIncumplimientoInformeGestion({ nombre, correo, contrato, periodoLabel, secciones, fechaLimite, url }) {
  const transporter = buildTransporter();
  await transporter.sendMail({
    from: `"Cinco Conecta" <${process.env.SMTP_USER}>`,
    replyTo: DESTINATARIO_RRHH,
    to: correo,
    cc: correo === DESTINATARIO_RRHH ? undefined : DESTINATARIO_RRHH,
    subject: `Aviso de incumplimiento — Informe de Gestión ${contrato} (${periodoLabel})`,
    html: incumplimientoInformeGestionHtml({ nombre, contrato, periodoLabel, secciones, fechaLimite, url })
  });
}

module.exports = {
  enviarConfirmacionPostulacion,
  enviarNotificacionRRHH,
  enviarCambioEtapa,
  enviarBienvenidaEmpleado,
  enviarNuevaPasswordEmpleado,
  enviarAsignacionInformeGestion,
  enviarIncumplimientoInformeGestion,
  ETAPA_TEXTO
};

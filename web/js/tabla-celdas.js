// Helpers puros (sin DOM, sin jsPDF/docx) para "celdas combinadas" en las
// tablas de Informes de Gestión. Compartidos entre el editor
// (informes-gestion.js) y el generador de PDF (pdf.js) para que ambos
// coincidan en qué celda es "ancla" y cuál queda "cubierta" por un rango
// combinado.
//
// Portado tal cual desde Cinco SAS control (web/js/control/tabla-celdas.js)
// — es un módulo genérico sin dependencias del otro repo.
//
// Un merge es { fila, col, filas, cols }: (fila,col) es la celda ancla
// (arriba-izquierda, 0-based) y filas/cols cuántas filas/columnas abarca.
// bloque.filas (la cuadrícula string[][]) no cambia de forma — los merges
// son solo una capa de "qué se ve combinado" encima de esa cuadrícula.

// Recorta cualquier merge que se salga de las dimensiones actuales de la
// tabla (p. ej. tras "- Fila"/"- Columna") y descarta los que quedaron
// degenerados (1×1, ya no combinan nada). Se llama de forma defensiva en
// cada punto que lee bloque.merges contra el tamaño actual de filas — así
// no hace falta ajustar merges a mano en cada botón +Fila/-Fila/etc.
export function normalizarMerges(merges, numFilas, numCols) {
  return (merges || [])
    .filter((m) => m && m.fila >= 0 && m.col >= 0 && m.fila < numFilas && m.col < numCols)
    .map((m) => ({
      fila: m.fila,
      col: m.col,
      filas: Math.max(1, Math.min(m.filas || 1, numFilas - m.fila)),
      cols: Math.max(1, Math.min(m.cols || 1, numCols - m.col))
    }))
    .filter((m) => m.filas > 1 || m.cols > 1);
}

// null si (fi,ci) es una celda normal, o { merge, esAncla } si cae dentro
// de un rango combinado (esAncla = es la celda arriba-izquierda de ese
// rango, la única que se muestra/dibuja).
export function celdaCombinada(merges, fi, ci) {
  for (const m of merges) {
    if (fi >= m.fila && fi < m.fila + m.filas && ci >= m.col && ci < m.col + m.cols) {
      return { merge: m, esAncla: fi === m.fila && ci === m.col };
    }
  }
  return null;
}

// Amplía un rango [fMin..fMax, cMin..cMax] hasta que incluya completo
// cualquier merge que toque, igual que Excel al seleccionar sobre celdas
// ya combinadas (repite hasta que el rango deja de crecer).
export function expandirRangoConMerges(merges, rango) {
  let { fMin, fMax, cMin, cMax } = rango;
  let cambio = true;
  while (cambio) {
    cambio = false;
    for (const m of merges) {
      const mfMax = m.fila + m.filas - 1;
      const mcMax = m.col + m.cols - 1;
      const solapa = m.fila <= fMax && mfMax >= fMin && m.col <= cMax && mcMax >= cMin;
      if (!solapa) continue;
      if (m.fila < fMin) { fMin = m.fila; cambio = true; }
      if (mfMax > fMax) { fMax = mfMax; cambio = true; }
      if (m.col < cMin) { cMin = m.col; cambio = true; }
      if (mcMax > cMax) { cMax = mcMax; cambio = true; }
    }
  }
  return { fMin, fMax, cMin, cMax };
}

// Quita cualquier merge que se cruce con un rango — usado al pegar datos
// de Excel/Word encima de celdas combinadas: los datos nuevos ya no
// respetan la combinación anterior.
export function quitarMergesQueIntersectan(merges, fMin, fMax, cMin, cMax) {
  return merges.filter((m) => {
    const mfMax = m.fila + m.filas - 1;
    const mcMax = m.col + m.cols - 1;
    return !(m.fila <= fMax && mfMax >= fMin && m.col <= cMax && mcMax >= cMin);
  });
}

// Cuántas filas desde arriba cuentan como "encabezado" (se repiten al
// principio de cada página nueva en PDF) cuando nadie lo fijó a mano: si la
// fila 0 tiene alguna celda combinada horizontalmente (un grupo de
// columnas), la fila 1 también cuenta como encabezado — así, con solo
// insertar una fila y combinar celdas en la fila 0, el resto sale solo,
// sin tener que configurar nada aparte.
export function filasEncabezadoAutomatico(numFilas, merges) {
  const fila0TieneGrupoDeColumnas = (merges || []).some((m) => m.fila === 0 && m.cols > 1 && m.filas === 1);
  return Math.min(numFilas, fila0TieneGrupoDeColumnas ? 2 : 1);
}

// ---- alineación de celdas (centrado) ----
// bloque.centrados: array de { fila, col } — lista dispersa de qué celdas
// están centradas (todo lo que no está en la lista se alinea a la
// izquierda, el valor por defecto). Mismo criterio de "lista dispersa de
// coordenadas" que los merges, pero sin filas/cols porque acá cada celda
// se marca individualmente (al centrar una fila o columna completa se
// agregan todas sus coordenadas, no un solo rango).

export function celdaCentrada(centrados, fi, ci) {
  return (centrados || []).some((c) => c.fila === fi && c.col === ci);
}

// Recorta cualquier coordenada que se salga de las dimensiones actuales de
// la tabla — mismo criterio que normalizarMerges.
export function normalizarCentrados(centrados, numFilas, numCols) {
  return (centrados || []).filter((c) => c && c.fila >= 0 && c.col >= 0 && c.fila < numFilas && c.col < numCols);
}

// Agrega al centrado todas las coordenadas de [fMin..fMax, cMin..cMax] que
// todavía no estén marcadas.
export function centrarRango(centrados, fMin, fMax, cMin, cMax) {
  const resultado = centrados.slice();
  for (let fi = fMin; fi <= fMax; fi++) {
    for (let ci = cMin; ci <= cMax; ci++) {
      if (!celdaCentrada(resultado, fi, ci)) resultado.push({ fila: fi, col: ci });
    }
  }
  return resultado;
}

// Quita del centrado cualquier coordenada dentro de [fMin..fMax, cMin..cMax].
export function alinearIzquierdaRango(centrados, fMin, fMax, cMin, cMax) {
  return centrados.filter((c) => !(c.fila >= fMin && c.fila <= fMax && c.col >= cMin && c.col <= cMax));
}

// ---- alineación VERTICAL de celdas (centrado dentro del alto de su fila)
// — mismo criterio de "lista dispersa de coordenadas" que "centrados"
// (horizontal), pero independiente: una celda puede estar centrada en
// horizontal, en vertical, en ambas o en ninguna. Por defecto (fuera de la
// lista) el texto queda arriba de la celda, igual que hasta ahora — esto
// solo importa qudo la fila es más alta de lo que esa celda puntual
// necesita (ej. una celda corta al lado de otra con varias líneas).
export function celdaCentradaVertical(centradosV, fi, ci) {
  return (centradosV || []).some((c) => c.fila === fi && c.col === ci);
}

export function normalizarCentradosVertical(centradosV, numFilas, numCols) {
  return (centradosV || []).filter((c) => c && c.fila >= 0 && c.col >= 0 && c.fila < numFilas && c.col < numCols);
}

export function centrarVerticalRango(centradosV, fMin, fMax, cMin, cMax) {
  const resultado = centradosV.slice();
  for (let fi = fMin; fi <= fMax; fi++) {
    for (let ci = cMin; ci <= cMax; ci++) {
      if (!celdaCentradaVertical(resultado, fi, ci)) resultado.push({ fila: fi, col: ci });
    }
  }
  return resultado;
}

// Quita el centrado vertical (vuelve a "arriba", el valor por defecto) de
// cualquier coordenada dentro de [fMin..fMax, cMin..cMax].
export function alinearArribaRango(centradosV, fMin, fMax, cMin, cMax) {
  return centradosV.filter((c) => !(c.fila >= fMin && c.fila <= fMax && c.col >= cMin && c.col <= cMax));
}

// ---- negrilla y color por celda ----
// Mismo criterio disperso que "centrados": negritas es un array de
// {fila,col}; coloresCelda es un array de {fila,col,color} con color en
// hex "#rrggbb". Cada celda del cuerpo (fila 0 ya sale en negrilla por ser
// encabezado, ver dibujarTabla) puede además marcarse en negrilla y/o con
// un color de letra propio — pensado para resaltar filas/celdas puntuales
// dentro de una tabla larga, no para texto con varios estilos mezclados
// dentro de la misma celda.

export function celdaNegrita(negritas, fi, ci) {
  return (negritas || []).some((c) => c.fila === fi && c.col === ci);
}

export function normalizarNegritas(negritas, numFilas, numCols) {
  return (negritas || []).filter((c) => c && c.fila >= 0 && c.col >= 0 && c.fila < numFilas && c.col < numCols);
}

export function negritaRango(negritas, fMin, fMax, cMin, cMax) {
  const resultado = negritas.slice();
  for (let fi = fMin; fi <= fMax; fi++) {
    for (let ci = cMin; ci <= cMax; ci++) {
      if (!celdaNegrita(resultado, fi, ci)) resultado.push({ fila: fi, col: ci });
    }
  }
  return resultado;
}

export function quitarNegritaRango(negritas, fMin, fMax, cMin, cMax) {
  return negritas.filter((c) => !(c.fila >= fMin && c.fila <= fMax && c.col >= cMin && c.col <= cMax));
}

export function colorCelda(coloresCelda, fi, ci) {
  const c = (coloresCelda || []).find((c) => c.fila === fi && c.col === ci);
  return c ? c.color : null;
}

export function normalizarColoresCelda(coloresCelda, numFilas, numCols) {
  return (coloresCelda || []).filter((c) => c && c.fila >= 0 && c.col >= 0 && c.fila < numFilas && c.col < numCols);
}

// Fija (o quita, si color es null) el color de todas las celdas de un rango.
export function colorearRango(coloresCelda, fMin, fMax, cMin, cMax, color) {
  const resultado = coloresCelda.filter((c) => !(c.fila >= fMin && c.fila <= fMax && c.col >= cMin && c.col <= cMax));
  if (!color) return resultado;
  for (let fi = fMin; fi <= fMax; fi++) {
    for (let ci = cMin; ci <= cMax; ci++) resultado.push({ fila: fi, col: ci, color });
  }
  return resultado;
}

// ---- listas de opciones por columna (celdas tipo "Sí/No/N.A.") ----
// bloque.opcionesColumna: objeto { [indiceColumna]: ["Sí", "No", ...] } —
// una columna con opciones definidas se edita con un <select> en vez de un
// <input> de texto libre en cada celda del cuerpo (la fila 0, de
// encabezado, sigue siendo texto libre). No afecta el PDF: ahí solo se
// dibuja el valor guardado en la celda, igual que cualquier otra.
export function normalizarOpcionesColumna(opcionesColumna, numCols) {
  const resultado = {};
  Object.entries(opcionesColumna || {}).forEach(([ci, opciones]) => {
    const i = Number(ci);
    if (i >= 0 && i < numCols && Array.isArray(opciones) && opciones.length) resultado[i] = opciones;
  });
  return resultado;
}

// ---- ancho de columnas del editor (cuadrícula de <input>) ----
// El ancho de cada columna no se reparte en partes iguales, sino
// proporcional a cuánto texto tiene esa columna. Acá se usa el largo del
// texto (en caracteres) en vez de medir con getTextWidth/canvas porque es
// la cuadrícula EN VIVO del editor (se recalcula en cada tecla) y no vale
// la pena el costo/la complejidad de medir con precisión de píxeles solo
// para la vista de edición.
export function anchosColumnaEditor(filas, merges, numFilas, numCols) {
  const ANCHO_MIN_CH = 6;
  const ANCHO_MAX_CH = 40;
  const pesos = new Array(numCols).fill(ANCHO_MIN_CH);
  for (let ci = 0; ci < numCols; ci++) {
    for (let fi = 0; fi < numFilas; fi++) {
      if (celdaCombinada(merges, fi, ci)) continue; // se mide aparte, más abajo, repartido entre las columnas que abarca
      const largo = String(filas[fi]?.[ci] || "").length;
      if (largo > pesos[ci]) pesos[ci] = largo;
    }
  }
  // El largo de una celda combinada se reparte entre las columnas que
  // abarca: ni se ignora del todo (dejaba angostas columnas cuya única
  // pista de ancho era un encabezado combinado), ni se le carga entero a
  // una sola columna.
  merges.forEach((m) => {
    const texto = String(filas[m.fila]?.[m.col] || "");
    if (!texto) return;
    const largoPorColumna = texto.length / m.cols;
    for (let ci = m.col; ci < m.col + m.cols; ci++) {
      if (largoPorColumna > pesos[ci]) pesos[ci] = largoPorColumna;
    }
  });
  return pesos.map((p) => Math.min(p, ANCHO_MAX_CH));
}

// Ajusta "filas" (en el sitio, misma referencia) a un número exacto de
// filas y columnas de una sola vez — crece agregando celdas vacías al
// final, encoge quitando desde el final. Para el control "Filas x
// Columnas" del editor, en vez de tener que hacer clic en +/- Fila y +/-
// Columna una por una hasta llegar al tamaño que se necesita.
export function redimensionarFilas(filas, numFilasObjetivo, numColsObjetivo) {
  while (filas.length < numFilasObjetivo) filas.push(new Array(numColsObjetivo).fill(""));
  while (filas.length > numFilasObjetivo) filas.pop();
  filas.forEach((fila) => {
    while (fila.length < numColsObjetivo) fila.push("");
    while (fila.length > numColsObjetivo) fila.pop();
  });
}

// ---- insertar/quitar una fila en una posición cualquiera (no solo al
// final) — para tablas largas donde hace falta meter o sacar una fila en
// medio sin tener que recortar y volver a pegar todo lo de abajo.
// "indice" es 0-based; insertar en indice=N agrega la fila nueva ANTES de
// la fila que hoy está en esa posición.

export function insertarFila(filas, indice, numCols) {
  filas.splice(indice, 0, new Array(numCols).fill(""));
}

export function eliminarFila(filas, indice) {
  filas.splice(indice, 1);
}

// Desplaza el índice de fila de cada merge que le corresponda. Si la fila
// se inserta/quita en medio de un merge vertical (no en su primera fila),
// el merge crece o se encoge una fila en vez de quedar "descuadrado" —
// igual que Excel/Word al insertar una fila en medio de celdas combinadas.
function desplazarFilaEnMerges(merges, indice, insertando) {
  return merges.map((m) => {
    if (insertando) {
      if (indice <= m.fila) return { ...m, fila: m.fila + 1 };
      if (indice < m.fila + m.filas) return { ...m, filas: m.filas + 1 };
      return m;
    }
    if (indice < m.fila) return { ...m, fila: m.fila - 1 };
    if (indice < m.fila + m.filas) return { ...m, filas: m.filas - 1 };
    return m;
  });
}

// Mismo desplazamiento para las listas dispersas de coordenadas
// (centrados/negritas/coloresCelda: todas son [{fila, col, ...}]). Al
// quitar una fila, cualquier coordenada que estuviera justo ahí se
// descarta (esa celda ya no existe).
function desplazarFilaEnCoordenadas(lista, indice, insertando) {
  if (insertando) return lista.map((c) => (c.fila >= indice ? { ...c, fila: c.fila + 1 } : c));
  return lista.filter((c) => c.fila !== indice).map((c) => (c.fila > indice ? { ...c, fila: c.fila - 1 } : c));
}

// Envuelve insertarFila/eliminarFila + el desplazamiento de merges/
// centrados/negritas/coloresCelda del bloque, para no repetir las cuatro
// llamadas cada vez que el editor inserta o quita una fila.
export function insertarFilaEnBloque(bloque, indice, numCols) {
  insertarFila(bloque.filas, indice, numCols);
  bloque.merges = desplazarFilaEnMerges(bloque.merges || [], indice, true);
  bloque.centrados = desplazarFilaEnCoordenadas(bloque.centrados || [], indice, true);
  bloque.centradosVertical = desplazarFilaEnCoordenadas(bloque.centradosVertical || [], indice, true);
  bloque.negritas = desplazarFilaEnCoordenadas(bloque.negritas || [], indice, true);
  bloque.coloresCelda = desplazarFilaEnCoordenadas(bloque.coloresCelda || [], indice, true);
}

export function eliminarFilaEnBloque(bloque, indice) {
  eliminarFila(bloque.filas, indice);
  bloque.merges = desplazarFilaEnMerges(bloque.merges || [], indice, false);
  bloque.centrados = desplazarFilaEnCoordenadas(bloque.centrados || [], indice, false);
  bloque.centradosVertical = desplazarFilaEnCoordenadas(bloque.centradosVertical || [], indice, false);
  bloque.negritas = desplazarFilaEnCoordenadas(bloque.negritas || [], indice, false);
  bloque.coloresCelda = desplazarFilaEnCoordenadas(bloque.coloresCelda || [], indice, false);
}

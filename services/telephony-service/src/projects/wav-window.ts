/**
 * Leer un tramo de un WAV sin bajarse el archivo entero.
 *
 * Los picos de una ventana existen para que ampliar la vista en un audio
 * largo siga teniendo detalle. El problema es el coste: con una descarga
 * completa por ventana, cada vez que alguien desplaza la vista se bajan los
 * doscientos megas del segmento para mirar dos décimas de segundo.
 *
 * Un WAV con PCM lineal no necesita eso. Los bytes de audio están uno detrás
 * de otro, así que el tramo que corresponde a una fracción del archivo es una
 * cuenta, y S3 sabe servir un rango de bytes. Lo único que hace falta es saber
 * dónde empieza el bloque `data` y cuánto mide, y eso lo dice la cabecera.
 *
 * Todo lo de aquí es puro: entra un Buffer, sale una cuenta.
 */

export interface CabeceraWav {
  /** Primer byte de muestras dentro del archivo. */
  dataOffset: number;
  /** Cuántos bytes de muestras hay. */
  dataBytes: number;
  bitsPerSample: number;
  channels: number;
  sampleRate: number;
}

/** Cuántos bytes ocupa un fotograma (una muestra de cada canal). */
export function bytesPorFotograma(cab: CabeceraWav): number {
  return Math.max(1, (cab.bitsPerSample / 8) * cab.channels);
}

/**
 * La cabecera, recorriendo los bloques de verdad en vez de dar por hecho que
 * ocupa 44 bytes. Es lo normal en un WAV de 16 bits sin extras, pero en cuanto
 * el archivo trae un bloque `LIST` (que es lo que mete ffmpeg con los
 * metadatos) el audio empieza más adelante y los 44 bytes fijos se comen
 * basura y la pintan como si fuera sonido.
 *
 * Devuelve null si esto no es un WAV con PCM entero, y entonces el que llama
 * se baja el archivo entero como siempre.
 */
export function leerCabeceraWav(head: Buffer): CabeceraWav | null {
  if (head.length < 12) return null;
  if (head.toString("ascii", 0, 4) !== "RIFF") return null;
  if (head.toString("ascii", 8, 12) !== "WAVE") return null;

  let offset = 12;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let formato = 0;

  while (offset + 8 <= head.length) {
    const id = head.toString("ascii", offset, offset + 4);
    const size = head.readUInt32LE(offset + 4);
    const cuerpo = offset + 8;

    if (id === "fmt ") {
      if (cuerpo + 16 > head.length) return null;
      formato = head.readUInt16LE(cuerpo);
      channels = head.readUInt16LE(cuerpo + 2);
      sampleRate = head.readUInt32LE(cuerpo + 4);
      bitsPerSample = head.readUInt16LE(cuerpo + 14);
    } else if (id === "data") {
      // 0xFFFFFFFF es lo que escriben los que graban en streaming y no saben
      // el tamaño final; ahí el bloque llega hasta el final del archivo y lo
      // resuelve el que llama con el tamaño real del objeto.
      const dataBytes = size === 0xffffffff ? 0 : size;
      if (channels <= 0 || bitsPerSample <= 0) return null;
      // Solo PCM entero (1). Un float de 32 bits (3) o un comprimido se leen
      // distinto, y leerlos como enteros daría una onda inventada.
      if (formato !== 1) return null;
      if (bitsPerSample !== 8 && bitsPerSample !== 16 && bitsPerSample !== 24 && bitsPerSample !== 32) {
        return null;
      }
      return { dataOffset: cuerpo, dataBytes, bitsPerSample, channels, sampleRate };
    }

    // Los bloques van alineados a par.
    offset = cuerpo + size + (size % 2);
  }
  return null;
}

export interface RangoDeBytes {
  /** Primer byte a pedir, inclusive. */
  start: number;
  /** Último byte a pedir, inclusive (como lo quiere la cabecera Range). */
  end: number;
  /** Cuántos fotogramas caen dentro. */
  frames: number;
}

/**
 * El rango de bytes que cubre la fracción `desde`..`hasta` del audio,
 * cuadrado a fotograma entero: si el rango empezara a media muestra, los
 * enteros de 16 bits se leerían cruzados y saldría ruido en vez de la onda.
 */
export function rangoDeBytes(
  cab: CabeceraWav,
  totalBytes: number,
  desde: number,
  hasta: number,
): RangoDeBytes | null {
  const bpf = bytesPorFotograma(cab);
  const disponibles = cab.dataBytes > 0
    ? Math.min(cab.dataBytes, totalBytes - cab.dataOffset)
    : totalBytes - cab.dataOffset;
  if (!Number.isFinite(disponibles) || disponibles < bpf) return null;

  const framesTotales = Math.floor(disponibles / bpf);
  const d = Math.min(Math.max(desde, 0), 1);
  const h = Math.min(Math.max(hasta, 0), 1);
  const inicioFrame = Math.min(framesTotales - 1, Math.floor(d * framesTotales));
  const finFrame = Math.max(inicioFrame + 1, Math.min(framesTotales, Math.ceil(h * framesTotales)));

  const start = cab.dataOffset + inicioFrame * bpf;
  const end = cab.dataOffset + finFrame * bpf - 1;
  return { start, end, frames: finFrame - inicioFrame };
}

/**
 * La envolvente: el pico absoluto de cada cubo, normalizado a 0..1.
 *
 * Pico y no RMS, que es lo que hace cualquier dibujante de ondas (audiowaveform,
 * peaks.js, wavesurfer): el RMS aplasta los transitorios y deja una banda sin
 * forma. Si se piden más cubos que muestras hay, se devuelven tantos cubos
 * como muestras: pedir 2000 picos de 500 muestras daba cubos de cero muestras
 * y la onda salía plana, que es justo el fallo al ampliar mucho.
 */
export function picosDeMuestras(
  leer: (i: number) => number,
  frames: number,
  pedidos: number,
  maximo: number,
): number[] {
  if (frames <= 0 || pedidos <= 0) return [];
  const count = Math.max(1, Math.min(pedidos, frames));
  const tamano = frames / count;
  const salida: number[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const inicio = Math.floor(i * tamano);
    const fin = Math.max(inicio + 1, Math.min(frames, Math.floor((i + 1) * tamano)));
    let pico = 0;
    for (let j = inicio; j < fin; j++) {
      const v = Math.abs(leer(j));
      if (v > pico) pico = v;
    }
    salida[i] = Math.round((pico / maximo) * 1000) / 1000;
  }
  return salida;
}

export interface LectorDeFotogramas {
  /** El valor absoluto mayor de los canales del fotograma `i`. */
  leer: (i: number) => number;
  frames: number;
  /** El valor que vale 1 al normalizar. */
  maximo: number;
}

/**
 * Un lector de fotogramas sobre un trozo de bloque `data`.
 *
 * Toma el mayor de los canales y no solo el primero: la envolvente dibuja lo
 * que se oye, y un golpe que solo está en el canal derecho se oye igual.
 *
 * Los ocho bits son la rareza de siempre: el WAV los guarda sin signo, con el
 * silencio en 128, mientras que los de 16, 24 y 32 van con signo y el silencio
 * en cero.
 */
export function lectorDeFotogramas(buf: Buffer, cab: CabeceraWav): LectorDeFotogramas {
  const bytes = cab.bitsPerSample / 8;
  const canales = Math.max(1, cab.channels);
  const bpf = bytes * canales;
  const frames = Math.floor(buf.length / bpf);
  const maximo = cab.bitsPerSample === 8 ? 128 : 2 ** (cab.bitsPerSample - 1);

  const muestra = (p: number): number => {
    switch (cab.bitsPerSample) {
      case 8:
        return buf.readUInt8(p) - 128;
      case 16:
        return buf.readInt16LE(p);
      case 24: {
        const v = buf.readUInt8(p) | (buf.readUInt8(p + 1) << 8) | (buf.readInt8(p + 2) << 16);
        return v;
      }
      default:
        return buf.readInt32LE(p);
    }
  };

  return {
    frames,
    maximo,
    leer: (i: number) => {
      const base = i * bpf;
      let pico = 0;
      for (let c = 0; c < canales; c++) {
        const v = Math.abs(muestra(base + c * bytes));
        if (v > pico) pico = v;
      }
      return pico;
    },
  };
}

/**
 * El número de bytes del objeto, sacado de la cabecera `Content-Range` que
 * devuelve una petición por rango ("bytes 0-8191/1234567").
 */
export function tamanoDeContentRange(contentRange: string | undefined): number | null {
  if (!contentRange) return null;
  const barra = contentRange.lastIndexOf("/");
  if (barra < 0) return null;
  const total = Number(contentRange.slice(barra + 1));
  return Number.isFinite(total) && total > 0 ? total : null;
}
